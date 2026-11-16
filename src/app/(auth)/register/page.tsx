import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/login-screen";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Create account" };

export default function RegisterPage() {
  return (
    <AuthShell title="Create your account" subtitle="A name, an email and a password. You can add a photo and profile details later in Settings.">
      <RegisterForm />
    </AuthShell>
  );
}
