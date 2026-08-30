import { useState } from "react";
import { WelcomeScreen } from "./WelcomeScreen";
import { EmailEntryScreen } from "./EmailEntryScreen";
import { OtpVerificationScreen } from "./OtpVerificationScreen";

type Phase = "welcome" | "email" | "otp";

export function LoginScreen() {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [email, setEmail] = useState<string | null>(null);
  const [emailDelivered, setEmailDelivered] = useState(true);

  if (phase === "welcome") {
    return <WelcomeScreen onGetStarted={() => setPhase("email")} />;
  }

  if (phase === "otp" && email) {
    return (
      <OtpVerificationScreen
        email={email}
        emailDelivered={emailDelivered}
        onChangeEmail={() => setPhase("email")}
      />
    );
  }

  return (
    <EmailEntryScreen
      onOtpSent={(sentEmail, delivered) => {
        setEmail(sentEmail);
        setEmailDelivered(delivered);
        setPhase("otp");
      }}
    />
  );
}
