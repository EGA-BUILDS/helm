const issuer = process.env.CLERK_ISSUER_DOMAIN;

const authConfig = {
  providers: issuer
    ? [{ domain: issuer, applicationID: "convex" }]
    : [],
};

export default authConfig;
