import type { ConfirmationResult } from "firebase/auth";
import { signInWithPhoneNumber, RecaptchaVerifier, PhoneAuthProvider, signInWithCredential } from "firebase/auth";
import { auth } from "../firebase";

let _confirmationResult: ConfirmationResult | null = null;

//send otp
export async function sendOtp(phoneNumber: string): Promise<{ success: boolean }> {
  const verifier = new RecaptchaVerifier(auth, "recaptcha-container", {
    size: "invisible",
  });

  _confirmationResult = await signInWithPhoneNumber(auth, `+91${phoneNumber}`, verifier);
  return { success: true };
}

//verify otp
export async function verifyOtp(
  _phoneNumber: string,
  otp: string,
): Promise<{ token: string; userId: string }> {
  if (!_confirmationResult) {
    throw new Error("No OTP session found — call sendOtp first.");
  }

  const credential = PhoneAuthProvider.credential(
    _confirmationResult.verificationId,
    otp,
  );
  const userCredential = await signInWithCredential(auth, credential);
  const token = await userCredential.user.getIdToken();

  _confirmationResult = null;
  return { token, userId: userCredential.user.uid };
}
