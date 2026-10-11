import type { ReactNode } from 'react';

/**
 * The text the app read from one page, shown at a readable size where the scan would be, so it
 * can be compared against it (toggle Scan and Text). Where nothing was read, it says so and
 * offers what can be done about it.
 */
export default function PageTextPanel({ text, empty }: { text: string | null | undefined; empty: ReactNode }) {
  if (!text?.trim()) {
    return <div className="bg-white border border-gray-200 rounded-xl p-6 text-sm text-gray-600 space-y-3">{empty}</div>;
  }
  return (
    <pre className="bg-white border border-gray-200 rounded-xl p-5 text-sm leading-relaxed text-gray-800 whitespace-pre-wrap break-words font-sans min-h-[24rem]">
      {text}
    </pre>
  );
}
