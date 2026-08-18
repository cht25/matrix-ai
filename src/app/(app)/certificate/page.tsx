import { redirect } from "next/navigation";

// Certificates list lives at /certificates.
export default function CertificateAlias() {
  redirect("/certificates");
}
