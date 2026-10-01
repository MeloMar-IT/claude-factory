import { createUser, findUserByEmail } from "../../src/auth/users.js";

export const TEST_PASSWORD = "test-password-12345";

export interface TestSession {
  /** `name=token`, ready for a cookie header. */
  cookie: string;
  token: string;
  csrf: string;
  user: { id: string; name: string; email: string; role: string };
  /** Headers for a call: the cookie, and the CSRF token for methods other than GET/HEAD. */
  headers(method?: string, extra?: Record<string, string>): Record<string, string>;
}

/**
 * Signs in over HTTP (creating the account first when it is missing) and returns what a browser would hold.
 * The data folder is the current FACTORY_HOME.
 */
export async function signInAs(
  base: string,
  opts: { name?: string; email?: string; password?: string; role?: "admin" | "user"; create?: boolean } = {},
): Promise<TestSession> {
  const { name = "Test Admin", email = "admin@example.com", password = TEST_PASSWORD, role = "admin", create = true } = opts;
  if (create && !findUserByEmail(email)) await createUser({ name, email, password, role });
  const res = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`sign-in failed with ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { user: TestSession["user"]; csrfToken: string };
  const cookie = res.headers.getSetCookie()[0]!.split(";")[0]!;
  return {
    cookie,
    token: cookie.slice(cookie.indexOf("=") + 1),
    csrf: body.csrfToken,
    user: body.user,
    headers: (method = "GET", extra = {}) => ({
      cookie,
      ...(method === "GET" || method === "HEAD" ? {} : { "x-csrf-token": body.csrfToken }),
      ...extra,
    }),
  };
}
