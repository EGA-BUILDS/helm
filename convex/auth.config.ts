const issuer = process.env.CLERK_FRONTEND_API_URL;

const authConfig = {
  providers: issuer
    ? [{ domain: issuer, applicationID: "convex" }]
    : [],
};

export default authConfig;
