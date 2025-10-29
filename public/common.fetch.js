const apiPrefix = window.location.pathname.startsWith("/admin") ? "/admin" : "";
const withBase = (url = "") => {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${apiPrefix}${url}`;
  return `${apiPrefix}/${url}`;
};

export const postFetch = async (url, { body }) => {
  return await fetch(withBase(url), {
    method: "post",
    cache: "no-cache",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
};

export const patchFetch = async (url, { body }) => {
  return await fetch(withBase(url), {
    method: "get",
    cache: "no-cache",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
};

export const deleteFetch = async (url, { body }) => {
  return await fetch(withBase(url), {
    method: "delete",
    cache: "no-cache",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
};
