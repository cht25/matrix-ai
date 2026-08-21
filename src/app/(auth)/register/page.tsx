import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/login-screen";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Create account" };

export default function RegisterPage() {
  return (
    <AuthShell title="Get started" subtitle="Create your MATRIX account — then start chatting.">
      <RegisterForm />
    </AuthShell>
  );
}
