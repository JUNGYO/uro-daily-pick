export default function KnowledgeRefresh({ resource }) {
  return (
    <div className="knowledge-refresh" aria-label="Knowledge refresh">
      <span role="status">
        {resource.refreshError
          ? "Refresh unavailable. Showing the last successful response."
          : resource.checkedAt
            ? `Checked ${resource.checkedAt.toLocaleTimeString("en-GB")} · Refreshes automatically`
            : "Checking for updates…"}
      </span>
      <button type="button" onClick={resource.reload} disabled={resource.refreshing}>
        {resource.refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}
