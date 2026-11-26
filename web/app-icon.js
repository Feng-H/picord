// The app's icons in the colors in use: the tab's icon (an SVG drawn here) and the home-screen icon (`apple-touch-icon`,
// which iOS and Android's "add to home screen" shortcut read; the server draws its PNG). The files in this folder
// (`icon.svg` and its PNGs) are the first load's icons, and stay where this module does not run. The web app manifest's icons
// follow the same cookie: the server answers `/manifest.webmanifest` with them.

const SIZE = 512;
const APPLE = 180;
// What a palette lacks keeps the app's own icon color.
const DEFAULTS = {
    "--o-bg": "#1a1b26",
    "--o-bg-darker": "#13141c",
    "--o-orange": "#ff9e64",
    "--o-cyan": "#33ccff",
    "--o-green": "#00ff99",
};

/** The icon as SVG text, from the palette's variables (`themeVars`): the drawing of `icon.svg` in the palette's colors. */
export function iconSvg(vars) {
    const color = (name) => vars[name] ?? DEFAULTS[name];

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
        <defs>
            <linearGradient id="ring" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0" stop-color="${color("--o-cyan")}" />
                <stop offset="1" stop-color="${color("--o-green")}" />
            </linearGradient>
        </defs>
        <rect width="${SIZE}" height="${SIZE}" fill="${color("--o-bg-darker")}" />
        <rect x="40" y="40" width="432" height="432" rx="75" fill="${color("--o-bg")}" stroke="url(#ring)" stroke-width="12" />
        <g transform="translate(73, 58) scale(5.55)">
            <path fill="${color("--o-orange")}" fill-rule="evenodd" d="M 56.4 16.3 C 52.2 14.3 47.6 13 42.8 12.1 C 42.1 13.4 41.3 15.1 40.7 16.6 C 35.6 15.8 30.4 15.8 25.3 16.6 C 24.7 15.1 23.9 13.4 23.2 12.1 C 18.4 13 13.8 14.3 9.6 16.3 C 0.9 29.3 -1.4 42 0.8 54.4 C 6.5 58.7 12.1 61.3 17.5 63 C 18.9 61.1 20.1 59.1 21.2 56.9 C 19.2 56.1 17.4 55.1 15.6 53.9 C 16.1 53.5 16.5 53.1 17 52.8 C 27.6 57.7 39 57.7 49.5 52.8 C 49.9 53.1 50.4 53.5 50.8 53.9 C 49 55.1 47.2 56.1 45.3 56.9 C 46.4 59.1 47.6 61.1 49 63 C 54.5 61.3 60.1 58.7 65.7 54.4 C 68.3 39.5 64.3 26.8 56.4 16.3 Z M 16 30.5 C 18.5 30.5 20.5 33 20.5 36 C 20.5 39 18.5 41.5 16 41.5 C 13.5 41.5 11.5 39 11.5 36 C 11.5 33 13.5 30.5 16 30.5 Z M 50 30.5 C 52.5 30.5 54.5 33 54.5 36 C 54.5 39 52.5 41.5 50 41.5 C 47.5 41.5 45.5 39 45.5 36 C 45.5 33 47.5 30.5 50 30.5 Z M 23 23 C 25 21.6 28.5 20.8 33 20.8 C 37.5 20.8 41 21.6 43 23 C 42.2 24.1 40.5 24.8 38 24.8 L 28 24.8 C 25.5 24.8 23.8 24.1 23 23 Z M 26.5 24.8 L 30.5 24.8 L 30.5 45.8 L 26.5 45.8 Z M 35.5 24.8 L 39.5 24.8 L 39.5 39 C 39.5 42 40.8 43.2 43 43.2 C 44 43.2 45 42.6 45.6 41.6 L 46.5 42.6 C 45.3 44.1 43.8 44.8 42 44.8 C 38 44.8 35.5 42.2 35.5 39 Z" />
        </g>
    </svg>`;
}

const svgUrl = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/**
 * A palette color as the server takes it: hex with no `#`, 3 or 6 digits. Its alpha is dropped (an icon is opaque), and a
 * color in another form is the app's own.
 */
const hex = (vars, name) => {
    const value = (vars[name] ?? "").trim().replace("#", "").toLowerCase();
    const opaque = /^[0-9a-f]{8}$/.test(value)
        ? value.slice(0, 6)
        : /^[0-9a-f]{4}$/.test(value)
          ? value.slice(0, 3)
          : value;

    return /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(opaque) ? opaque : DEFAULTS[name].replace("#", "");
};

/**
 * The home-screen icon's address: the server draws the PNG (`src/server/icon-render.ts`). A phone fetches it when the
 * icon is added, and does not take a `data:` or `blob:` address for it.
 */
const homeIconUrl = (vars) => {
    const color = (name) => hex(vars, name);
    const query = new URLSearchParams({
        frame: color("--o-bg-darker"),
        card: color("--o-bg"),
        ring1: color("--o-cyan"),
        ring2: color("--o-green"),
        pi: color("--o-orange"),
        size: String(APPLE),
        v: "20261126",
    });

    return `/app-icon.png?${query}`;
};

/**
 * The colors in a cookie, `frame.card.ring1.ring2.pi` in hex: iOS may read the icon from the page as it is served, before
 * any script runs, so the server puts the address in the page from this cookie (`src/server/http/icon-route.ts`).
 */
const COOKIE = "pocket_icon";
const cookieValue = (vars) =>
    ["--o-bg-darker", "--o-bg", "--o-cyan", "--o-green", "--o-orange"]
        .map((name) => hex(vars, name))
        .join(".");

function setLink(rel, href, type) {
    let link = document.querySelector(
        type ? `link[rel="${rel}"][type="${type}"]` : `link[rel="${rel}"]`,
    );

    if (!link) {
        link = document.createElement("link");
        link.rel = rel;
        document.head.append(link);
    }

    if (type) {
        link.type = type;
    }

    link.removeAttribute("sizes");
    link.href = href;
}

/**
 * A phone fetches the page and the icon in a session of its own, with no cookie: the owner's browser tells the server the
 * colors too (`reportIconsAs`). Not awaited; a failure only leaves the cookie's colors.
 */
async function reportToServer(colors) {
    try {
        const response = await fetch("/api/app-icon", {
            method: "PUT",
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ colors }),
        });

        if (!response.ok && response.status !== 401 && response.status !== 403) {
            console.warn(
                `Pi Pocket: the icon colors were not kept by the server (${response.status}).`,
            );
        }
    } catch (error) {
        console.warn("Pi Pocket: the icon colors could not be sent to the server.", error);
    }
}

let applied = "";

/** The colors in use, `frame.card.ring1.ring2.pi`, and whether this browser reports them: only the owner's may. */
let colorsInUse = null;
let reports = false;

/** Once the person is known: the owner's browser reports the colors (a guest's or a viewer's would be refused). */
export function reportIconsAs(owner) {
    reports = owner;

    if (owner && colorsInUse !== null) {
        void reportToServer(colorsInUse);
    }
}

/** Put the icons for `vars` on the page: the tab's icon and the home-screen icon. The same colors again do nothing. */
export function applyIcons(vars) {
    const key = JSON.stringify(Object.keys(DEFAULTS).map((name) => vars[name]));

    if (key === applied) {
        return;
    }

    applied = key;
    setLink("icon", svgUrl(iconSvg(vars)), "image/svg+xml");
    setLink("apple-touch-icon", homeIconUrl(vars));
    colorsInUse = cookieValue(vars);
    document.cookie = `${COOKIE}=${colorsInUse}; path=/; max-age=31536000; samesite=lax`;

    if (reports) {
        void reportToServer(colorsInUse);
    }
}
