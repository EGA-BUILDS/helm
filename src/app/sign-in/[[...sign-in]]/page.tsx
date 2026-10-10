import { SignIn } from "@clerk/nextjs";
import { Suspense } from "react";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Suspense fallback={<p role="status">Loading secure sign-in…</p>}>
        <SignIn signUpUrl="" appearance={{ elements: { footerActionLink: { display: "none" } } }} />
      </Suspense>
    </div>
  );
}
