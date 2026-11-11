import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openExternalLink } from "../lib/external-link";

/** Bot/user prose: GitHub-flavored Markdown; links always leave the app shell. */
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (!href) return;
              event.preventDefault();
              void openExternalLink(href);
            }}
          >
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
