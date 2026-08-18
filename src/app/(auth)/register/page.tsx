import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Create account" };

export default function RegisterPage() {
  return (
    <AuthShell title="Create your account" subtitle="Start your cyber safety journey with MATRIX AI.">
      <RegisterForm />
    </AuthShell>
  );
}
