// =============================================================================
// Security overview — presentation only.
//
// The page (app/(app)/dashboard/page.tsx) reads the signed-in user's data and
// hands it down; this component only lays it out. Keeping it free of data
// access lets the same markup be rendered against sample data in
// /dev-preview/app, so the layout can be reviewed without a Firebase project.
// =============================================================================

import Link from "next/link";
import { Badge, Card, EmptyState, Progress } from "@/components/ui";
import { TimeAgoText } from "@/components/local-time";
import { formatDate, scoreLabel } from "@/lib/utils";

export type DashboardRecommendation = { text: string; href: string; cta: string };

export type DashboardViewProps = {
  firstName: string | null;
  score: number;
  emailConfirmed: boolean;
  ageVerified: boolean;
  completedLessons: number;
  certificates: Array<{ id: string; certificate_id: string; issued_at: string }>;
  events: Array<{ event_type: string; created_at: string }>;
  analyses: Array<{ risk_level: string; created_at: string }>;
  recommendations: DashboardRecommendation[];
};

/** One card heading with its optional "see more" link on the same line. */
function CardHeading({ title, href, cta }: { title: string; href?: string; cta?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-semibold text-ink">{title}</h2>
      {href && cta ? <Link href={href} className="shrink-0 text-xs font-semibold text-accent hover:text-accent-2">{cta} →</Link> : null}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <li className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">{children}</li>;
}

export function DashboardView({
  firstName, score, emailConfirmed, ageVerified, completedLessons, certificates, events, analyses, recommendations,
}: DashboardViewProps) {
  const scoreInfo = scoreLabel(score);
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="eyebrow mb-1.5">Security overview</p>
          <h1 className="truncate font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            Hi {firstName ?? "there"}
          </h1>
          <p className="mt-1 text-sm text-ink-2">Your cyber safety snapshot.</p>
        </div>
        <Link href="/chat" className="btn btn-primary shrink-0">Open QORVYNA AI</Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="flex flex-col justify-between">
          <p className="text-sm font-medium text-ink-2">Cyber Safety Score</p>
          <div className="mt-2 flex items-end gap-2">
            <span className={`font-display text-4xl font-semibold ${scoreInfo.color}`}>{score}</span>
            <span className="mb-1 text-sm font-semibold text-ink-3">/100</span>
          </div>
          <Progress value={score} className="mt-3" />
          <p className="mt-2 text-xs font-semibold text-ink-3">{scoreInfo.label}</p>
        </Card>
        <Card>
          <p className="text-sm font-medium text-ink-2">Email verification</p>
          <div className="mt-2">
            {emailConfirmed
              ? <Badge className="border-success/30 bg-success-soft text-success">Verified</Badge>
              : <Badge className="border-warning/30 bg-warning-soft text-warning">Not verified</Badge>}
          </div>
          <p className="mt-3 text-xs text-ink-3">Age verification: {ageVerified ? "verified" : "pending"}</p>
        </Card>
        <Card>
          <p className="text-sm font-medium text-ink-2">Lessons completed</p>
          <p className="mt-2 font-display text-4xl font-semibold text-ink">{completedLessons}</p>
          <p className="mt-2 text-xs text-ink-3">Every lesson raises your score.</p>
        </Card>
        <Card>
          <p className="text-sm font-medium text-ink-2">Certificates</p>
          <p className="mt-2 font-display text-4xl font-semibold text-ink">{certificates.length}</p>
          <Link href="/certificates" className="mt-2 inline-block text-xs font-semibold text-accent hover:text-accent-2">View certificates →</Link>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeading title="Security recommendations" />
          <ul className="mt-3 space-y-2">
            {recommendations.map((item) => (
              <li key={item.text} className="flex items-start justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                <span className="min-w-0 text-ink-2">{item.text}</span>
                <Link href={item.href} className="shrink-0 font-semibold text-accent hover:text-accent-2">{item.cta} →</Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeading title="Recent security events" href="/security" cta="View all" />
          {events.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {events.map((event, index) => (
                <Row key={index}>
                  <span className="min-w-0 truncate capitalize text-ink-2">{event.event_type.replaceAll("_", " ")}</span>
                  <span className="shrink-0 text-xs text-ink-3"><TimeAgoText iso={event.created_at} /></span>
                </Row>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-ink-3">No security events yet.</p>
          )}
        </Card>

        <Card>
          <CardHeading title="Recent scam analyses" href="/scanner" cta="Scan something" />
          {analyses.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {analyses.map((analysis, index) => (
                <Row key={index}>
                  <span className="min-w-0 truncate text-ink-2">Screenshot analysis</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge className="border-border bg-surface capitalize text-ink-2">{analysis.risk_level} risk</Badge>
                    <span className="text-xs text-ink-3"><TimeAgoText iso={analysis.created_at} /></span>
                  </span>
                </Row>
              ))}
            </ul>
          ) : (
            <div className="mt-3">
              <EmptyState title="No analyses yet" body="Upload a suspicious screenshot and QORVYNA will analyse it." />
            </div>
          )}
        </Card>

        <Card>
          <CardHeading title="Recent chats" href="/chat" cta="Open chat" />
          <p className="mt-3 text-sm text-ink-3">Your latest conversations are in the sidebar — or open the chat to continue.</p>
          {certificates.length > 0 ? (
            <div className="mt-4 border-t border-border pt-4">
              <h3 className="text-xs font-bold uppercase tracking-widest text-ink-3">Certificates</h3>
              <ul className="mt-2 space-y-1.5">
                {certificates.map((certificate) => (
                  <Row key={certificate.id}>
                    <span className="min-w-0 truncate font-mono text-ink-2">{certificate.certificate_id}</span>
                    <span className="shrink-0 text-xs text-ink-3">{formatDate(certificate.issued_at)}</span>
                  </Row>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
