/**
 * Mask auth secrets in a URL or any text that may contain one.
 *
 * For browser error reporting. Sentry records each history change as a
 * breadcrumb with the full relative URL, fragment included, so the reset page
 * removing `#token_hash=…` from the address bar would itself hand the token to
 * the next error report. Masked here instead.
 *
 * Only a parameter that starts the query or fragment, or follows `&`, matches:
 * `promo_code=` is left alone.
 */
const SECRET_PARAM =
  /([?#&](?:token_hash|token|code|access_token|refresh_token|provider_token|provider_refresh_token)=)[^&#\s"'<>]*/gi;

export function redactAuthSecrets(text: string): string {
  return text.replace(SECRET_PARAM, "$1[redacted]");
}

/**
 * The same, for every string inside arrays and plain objects a few levels
 * down. A console breadcrumb carries the logged values in `data.arguments` (an
 * array) beside the joined `message`; masking only the message would leave
 * the same URL readable next to it. Anything else (class instances, numbers)
 * is returned as it is.
 */
export function redactAuthSecretsDeep<T>(value: T, depth = 4): T {
  if (typeof value === "string") return redactAuthSecrets(value) as T;
  if (depth <= 0 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactAuthSecretsDeep(item, depth - 1)) as T;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactAuthSecretsDeep(item, depth - 1)])
  ) as T;
}

/** The fields of a Sentry breadcrumb that can carry a URL. */
export interface BreadcrumbLike {
  message?: string;
  data?: { [key: string]: unknown };
}

/** For Sentry's beforeBreadcrumb: navigation from/to, fetch URLs, console text. */
export function redactBreadcrumb<B extends BreadcrumbLike>(breadcrumb: B): B {
  if (breadcrumb.message) breadcrumb.message = redactAuthSecrets(breadcrumb.message);
  if (breadcrumb.data) breadcrumb.data = redactAuthSecretsDeep(breadcrumb.data);
  return breadcrumb;
}

/** The fields of a Sentry event that can carry a URL. */
export interface EventLike {
  message?: string;
  exception?: { values?: { value?: string }[] };
  request?: { url?: string; query_string?: unknown; headers?: { [key: string]: string } };
}

/**
 * For Sentry's beforeSend: the page URL, its query and headers, and the
 * message and exception text, in case an error ever quotes a URL. Stack
 * frames, error types and everything else are untouched.
 */
export function redactEvent<E extends EventLike>(event: E): E {
  if (event.message) event.message = redactAuthSecrets(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redactAuthSecrets(exception.value);
  }
  const request = event.request;
  if (request?.url) request.url = redactAuthSecrets(request.url);
  if (typeof request?.query_string === "string") {
    request.query_string = redactAuthSecrets(`?${request.query_string}`).slice(1);
  }
  if (request?.headers) {
    for (const [key, value] of Object.entries(request.headers)) {
      request.headers[key] = redactAuthSecrets(value);
    }
  }
  return event;
}
