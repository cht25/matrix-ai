// The certificate itself — one component, used by the preview modal, the
// public verification page and the print view, so what a learner sees on
// screen is exactly what comes out of the printer.

import { formatDate } from "@/lib/utils";

export type CertificateData = {
  certificate_id: string;
  display_name: string;
  course: string;
  score_percent: number;
  issued_at: string;
  issued_by: string;
};

export function CertificateDocument({ cert }: { cert: CertificateData }) {
  return (
    <article className="certificate" aria-label={`Certificate ${cert.certificate_id}`}>
      <p className="certificate-brand">MATRIX</p>
      <p className="certificate-title">Certificate of Completion</p>

      <p className="certificate-lede">This certifies that</p>
      <p className="certificate-name">{cert.display_name}</p>
      <p className="certificate-lede">has successfully completed</p>
      <p className="certificate-course">{cert.course}</p>

      <hr className="certificate-rule" />

      <dl className="certificate-meta">
        <div>
          <dt>Score</dt>
          <dd>{Math.round(cert.score_percent)}%</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{formatDate(cert.issued_at)}</dd>
        </div>
        <div>
          <dt>Certificate ID</dt>
          <dd className="mono">{cert.certificate_id}</dd>
        </div>
      </dl>

      <p className="certificate-footer">{cert.issued_by}</p>
    </article>
  );
}
