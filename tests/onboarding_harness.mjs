// Local UI fixture using the real Onboarding component with a simulated database.
// First save fails, retry succeeds. ?signedOut=1 exercises the login redirect.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../frontend/package.json", import.meta.url));
const { build } = require("esbuild");
const fixture = `
  import React from 'react';
  export const Auth = React.createContext(null);
  export const useAuth = () => React.useContext(Auth);
  let attempts = 0;
  let values;
  const query = {
    update(data) { values = data; return this; },
    eq() { return this; }, select() { return this; },
    async single() {
      attempts += 1;
      if (attempts === 1) return { data: null, error: { message: 'Simulated outage' } };
      return { data: { id: 'fixture', ...values }, error: null };
    }
  };
  export const supabase = { from() { return query; } };
`;
const result = await build({
  stdin: {
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { MemoryRouter, Routes, Route } from 'react-router-dom';
      import Onboarding from './src/pages/Onboarding.jsx';
      import { Auth } from 'fixture';
      function App() {
        const [profile, setProfile] = useState(null);
        const user = location.search.includes('signedOut=1') ? null : { id: 'fixture' };
        return <Auth.Provider value={{user, profile, setProfile}}>
          <MemoryRouter initialEntries={['/onboarding']}><Routes>
            <Route path='/onboarding' element={<Onboarding />} />
            <Route path='/login' element={<h1>Login required</h1>} />
            <Route path='/' element={<h1>{profile?.onboarding_done ? 'Saved profile' : 'Missing profile'}</h1>} />
          </Routes></MemoryRouter>
        </Auth.Provider>;
      }
      createRoot(document.getElementById('root')).render(<App />);
    `,
    loader: "jsx",
    resolveDir: fileURLToPath(new URL("../frontend/", import.meta.url)),
  },
  bundle: true,
  write: false,
  jsx: "automatic",
  logLevel: "silent",
  plugins: [
    {
      name: "fixture",
      setup(build) {
        build.onResolve({ filter: /^(fixture|\.\.\/lib\/auth|\.\.\/lib\/supabase)$/ }, () => ({
          path: "fixture",
          namespace: "fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: fixture,
          resolveDir: fileURLToPath(new URL("../frontend/", import.meta.url)),
        }));
      },
    },
  ],
});
createServer((req, res) => {
  if (req.url === "/app.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(result.outputFiles[0].contents);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><title>Onboarding regression fixture</title><div id="root"></div><script src="/app.js"></script>',
    );
  }
}).listen(3101, "127.0.0.1", () => console.log("Onboarding fixture: http://127.0.0.1:3101"));
