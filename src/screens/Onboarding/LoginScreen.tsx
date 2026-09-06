import { useState } from "react";
import { WelcomeScreen } from "./WelcomeScreen";
import { EmailEntryScreen } from "./EmailEntryScreen";
import { OtpVerificationScreen } from "./OtpVerificationScreen";
import { AdminPasswordScreen } from "./AdminPasswordScreen";
import type { SelfServeRole } from "../../services/api";

type Phase = "welcome" | "email" | "otp" | "admin-password";

export function LoginScreen() {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [email, setEmail] = useState<string | null>(null);
  const [emailDelivered, setEmailDelivered] = useState(true);
  const [intendedRole, setIntendedRole] = useState<SelfServeRole>("artisan");

  if (phase === "welcome") {
    return <WelcomeScreen onGetStarted={() => setPhase("email")} />;
  }

  if (phase === "admin-password" && email) {
    return <AdminPasswordScreen email={email} onChangeEmail={() => setPhase("email")} />;
  }

  if (phase === "otp" && email) {
    return (
      <OtpVerificationScreen
        email={email}
        emailDelivered={emailDelivered}
        intendedRole={intendedRole}
        onChangeEmail={() => setPhase("email")}
      />
    );
  }

  return (
    <EmailEntryScreen
      onOtpSent={(sentEmail, delivered, role, requiresPassword) => {
        setEmail(sentEmail);
        setEmailDelivered(delivered);
        setIntendedRole(role);
        setPhase(requiresPassword ? "admin-password" : "otp");
      }}
    />
  );
}
