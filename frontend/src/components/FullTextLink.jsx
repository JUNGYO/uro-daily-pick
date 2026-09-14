import { Link } from "react-router-dom";
import { BookOpen } from "lucide-react";
import { useAuth } from "../lib/auth";
import { canReadOriginal } from "../lib/fulltext";

export default function FullTextLink({ paper }) {
  const { user } = useAuth();
  if (!canReadOriginal(user, paper)) return null;
  return (
    <Link to={`/fulltext/${paper.pmid}`} className="btn-primary gap-1.5 text-sm no-underline">
      <BookOpen size={16} aria-hidden="true" /> 원문 보기
    </Link>
  );
}
