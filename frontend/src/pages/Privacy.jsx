import { Link } from "react-router-dom";

export default function Privacy() {
  return (
    <main className="page-shell max-w-3xl">
      <Link to="/welcome" className="text-accent underline text-sm">
        Uro Daily Pick
      </Link>
      <h1 className="page-title mt-6">Privacy & research use</h1>
      <div className="panel space-y-6 text-sm leading-relaxed">
        <section>
          <h2 className="section-title">Your research workspace</h2>
          <p>
            The service stores your account email, profile, research interests, paper feedback, reading
            activity, collections, and digest preferences. These records support authentication, personalized
            picks, reading insights, and email delivery. Account data is stored in Supabase; enabled email
            digests are sent through Resend.
          </p>
        </section>
        <section>
          <h2 className="section-title">Paper summaries</h2>
          <p>
            AI summaries are generated through Google Gemini from paper abstracts or available full text. The
            summary identifies its source basis. AI output can omit context or contain errors; check the
            original paper for figures, methods, and interpretation. This service is a research reading aid
            and does not provide patient-specific advice.
          </p>
        </section>
        <section>
          <h2 className="section-title">Your controls</h2>
          <p>
            You can change your preferences, turn off email digests, remove saved lists, or delete your
            account in Settings. Account deletion removes your profile, feedback, reading history,
            collections, recommendations, and delivery records from the application database. Infrastructure
            backups and provider logs follow their respective retention settings.
          </p>
        </section>
        <section>
          <h2 className="section-title">Use journal access responsibly</h2>
          <p>
            Publisher links may require your institution's subscription. Access to this app does not grant
            journal access. Imported full text is stored separately from public paper metadata. Do not enter
            patient information into your profile, keywords, alerts, or collection names.
          </p>
        </section>
        <Link to="/settings" className="inline-block text-accent underline">
          Manage your account
        </Link>
      </div>
    </main>
  );
}
