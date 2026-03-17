export const pagePaths = ["/overview", "/attempts", "/history", "/learnings"] as const;

export type PagePath = (typeof pagePaths)[number];

export type PageDefinition = {
  path: PagePath;
  label: string;
  title: string;
};

export const pages: PageDefinition[] = [
  { path: "/overview", label: "Overview", title: "Overview" },
  { path: "/attempts", label: "Attempts", title: "Attempts" },
  { path: "/history", label: "History", title: "History" },
  { path: "/learnings", label: "Learnings", title: "Learnings" },
];

export const normalizePath = (pathname: string): PagePath => {
  if (pathname === "/") {
    return "/overview";
  }

  return pagePaths.includes(pathname as PagePath) ? (pathname as PagePath) : "/overview";
};

export const titleForPath = (pathname: PagePath): string => pages.find((page) => page.path === pathname)?.title ?? "Overview";
