// Picord's docs: Starlight, at https://feng-h.github.io/picord/docs/, beside the product site (site/).
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { satteri } from "@astrojs/markdown-satteri";
import { idInLocale, idOf, pages, REPO, repoMarkdown, VERSION } from "./src/repo-docs.mjs";
import { SIDEBAR } from "./src/sidebar.mjs";

const listed = new Set(pages().map((path) => idOf(path)));
const problems = [];

for (const path of pages()) {
    if (!listed.has(idOf(path))) {
        problems.push(`${path} is a page, but not in the sidebar (docs-site/src/sidebar.mjs)`);
    }
}

for (const group of SIDEBAR) {
    for (const item of group.items) {
        if (typeof item.slug === "string" && !listed.has(item.slug)) {
            problems.push(`${item.slug} is in the sidebar, but not in the repository`);
        }
    }
}

if (problems.length > 0) {
    throw new Error(`The sidebar and the pages differ:\n${problems.join("\n")}`);
}

// 侧栏是单一数组:Starlight 会按当前语言解析 slug——中文页在中文站,英文参考页带 /en/ 前缀。
const sidebar = SIDEBAR.map(({ label, collapsed, items }) => ({
    label,
    collapsed: collapsed ?? false,
    items: items.map((item) =>
        Array.isArray(item)
            ? { slug: idOf(item[0]), label: item[1] }
            : item,
    ),
}));

export default defineConfig({
    site: "https://feng-h.github.io",
    base: "/picord/docs",
    trailingSlash: "always",
    devToolbar: { enabled: false },
    markdown: {
        processor: satteri({ mdastPlugins: [repoMarkdown] }),
    },
    vite: {
        // Pages and components get Pi Pocket's version this way: what they import is bundled, away from the repo.
        define: { __POCKET_VERSION__: JSON.stringify(VERSION) },
        server: { fs: { allow: [REPO] } },
    },
    integrations: [
        {
            // A copy of the public types beside the docs, for editors outside a Pi Pocket: /pi-pocket/docs/pocket.d.ts.
            name: "pocket-types",
            hooks: {
                "astro:build:done": ({ dir }) => {
                    const types = join(REPO, "types/pocket.d.ts");

                    if (existsSync(types)) {
                        copyFileSync(types, new URL("pocket.d.ts", dir));
                    }
                },
            },
        },
        starlight({
            title: "Picord docs",
            locales: {
                root: { label: "English", lang: "en" },
                zh: { label: "简体中文", lang: "zh" },
            },
            defaultLocale: "root",
            locales: {
                root: { label: "English", lang: "en" },
                zh: { label: "简体中文", lang: "zh" },
            },
            defaultLocale: "root",
            description:
                "Extend Picord: give Pi tools, rules, and checks, and add pages, buttons, and commands to the app.",
            logo: { src: "./public/icon.svg", alt: "" },
            favicon: "/icon.svg",
            social: [
                {
                    icon: "github",
                    label: "GitHub",
                    href: "https://github.com/Feng-H/picord",
                },
            ],
            components: {
                Footer: "./src/components/Footer.astro",
                SocialIcons: "./src/components/SocialIcons.astro",
            },
            customCss: ["./src/styles/pocket.css"],
            markdown: { processedDirs: [REPO] },
            expressiveCode: { defaultProps: { wrap: true } },
            sidebar,
            lastUpdated: false,
            pagination: true,
            credits: false,
            disable404Route: true,
        }),
    ],
});
