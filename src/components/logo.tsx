import Link from "next/link";

export function Logo({ size = "md", href = "/" }: { size?: "sm" | "md" | "lg"; href?: string }) {
  const dims = { sm: "h-7 w-7", md: "h-9 w-9", lg: "h-12 w-12" };
  const text = { sm: "text-lg", md: "text-xl", lg: "text-2xl" };
  return (
    <Link href={href} className="inline-flex items-center gap-2" aria-label="MATRIX AI home">
      <span className={`${dims[size]} grid place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-800 shadow-sm`}>
        <svg viewBox="0 0 24 24" fill="none" className="h-[60%] w-[60%]" aria-hidden="true">
          <path d="M12 2 3 7v6c0 5.25 3.9 8.1 9 9 5.1-.9 9-3.75 9-9V7l-9-5Z" stroke="white" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M8.5 12.5l2.5 2.5 4.5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className={`${text[size]} font-extrabold tracking-tight text-slate-900`}>
        MATRIX <span className="text-brand-600">AI</span>
      </span>
    </Link>
  );
}
