import { useState } from "react";
import { WelcomeScreen } from "./WelcomeScreen";
import { PhoneEntryScreen } from "./PhoneEntryScreen";
import { OtpVerificationScreen } from "./OtpVerificationScreen";

type Phase = "welcome" | "phone" | "otp";

export function LoginScreen() {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);

  if (phase === "welcome") {
    return <WelcomeScreen onGetStarted={() => setPhase("phone")} />;
  }

  if (phase === "otp" && phoneNumber) {
    return (
      <OtpVerificationScreen
        phoneNumber={phoneNumber}
        onChangeNumber={() => setPhase("phone")}
      />
    );
  }

  return (
    <PhoneEntryScreen
      onOtpSent={(sentPhoneNumber) => {
        setPhoneNumber(sentPhoneNumber);
        setPhase("otp");
      }}
    />
  );
}
