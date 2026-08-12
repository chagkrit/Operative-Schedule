export type SiteUser = {
  id: string;
  email: string;
  name: string;
};

export function getSiteUser(request: Request): SiteUser | null {
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email");
  const rawName = request.headers.get("oai-authenticated-user-full-name");
  const encoding = request.headers.get(
    "oai-authenticated-user-full-name-encoding",
  );

  if (id && email) {
    let name = email;
    if (rawName && encoding === "percent-encoded-utf-8") {
      try {
        name = decodeURIComponent(rawName);
      } catch {
        name = email;
      }
    }
    return { id, email, name };
  }

  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return { id: "local-preview", email: "preview@local", name: "Local preview" };
  }

  return null;
}
