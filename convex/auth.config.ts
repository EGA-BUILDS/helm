const issuer = process.env.CLERK_FRONTEND_API_URL;
if (!issuer) {
  throw new Error(
    "CLERK_FRONTEND_API_URL must be set to register the Clerk JWT provider",
  );
}

const authConfig = {
  providers: [{ domain: issuer, applicationID: "convex" }],
};

export default authConfig;
