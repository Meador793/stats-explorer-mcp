# Publishing Stats Explorer MCP

Two places, easiest first:

| | Where people find it | Steps | Time, first time |
|---|---|---|---|
| **A. VS Code Marketplace** | Extensions view in VS Code; marketplace.visualstudio.com | 4 | about 30 minutes |
| **B. Official MCP Registry** | Claude, Cursor, nao, and other MCP clients and directories | 5 (including npm) | about 45 minutes |

Both share three one-time preparation steps (section 0). You do all of this yourself, so no passwords or tokens ever pass through anyone else.

**What the listing shows.** The **Marketplace page** is `vscode-extension/README.md`. It has the hero image, your "14 statistics tools…" description, the hypothesis-test write-up, the chart gallery and the exploration report. The **GitHub and npm pages** use the root `README.md`, with the same description and images. The **MCP Registry** has no page with pictures: it stores metadata (name, description, version, icon, website link) that clients show in their own lists.

The images live in `docs/images/` and are linked from GitHub, so they appear once the repository is public on GitHub (step 0.3).

---

## 0. Preparation (once, used by both)

You need Node.js 24 LTS (from https://nodejs.org; version 22 also works) and Git, plus free accounts on GitHub, npm and a Microsoft account.

### 0.1 Pick your names

- **GitHub username**, e.g. `janedoe`. It becomes part of your MCP Registry name, `io.github.janedoe/stats-explorer-mcp`, and of the image links.
- **Marketplace publisher ID**, e.g. `statsexplorer`. Use lowercase letters, numbers and hyphens. It is permanent, and your extension's ID becomes `statsexplorer.stats-explorer-mcp`.
- **App URL:** where developers go to see the paid app (your marketing site's home or Buy page).

### 0.2 Fill them in everywhere

In the unzipped `stats-explorer-mcp` folder:

```bash
npm install
node scripts/set-identity.mjs --github YOUR_GITHUB_USERNAME --publisher YOUR_PUBLISHER_ID \
     --app-url https://YOUR-MARKETING-SITE.com --owner "Your Name or Company"
npm test
```

`npm test` should report **69 passing**. Then search the folder for `YOUR_` to confirm nothing is left (ignore this file and `scripts/set-identity.mjs`, which mention the placeholders on purpose).

### 0.3 Put the code on GitHub

Create a **public** repository named exactly `stats-explorer-mcp` on github.com (no README, no license; the folder has both). Then:

```bash
git init
git add -A && git commit -m "Stats Explorer MCP 1.1.1"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/stats-explorer-mcp.git
git push -u origin main
```

Check it: open `https://github.com/YOUR_GITHUB_USERNAME/stats-explorer-mcp`. The README should show the hero image and the other three pictures. If the images are missing, the repository is private, or its name or branch isn't exactly `stats-explorer-mcp` / `main`.

The included GitHub Actions workflow now runs every test on Windows, macOS and Linux on each push. Check the **Actions** tab shows a green tick.

---

## A. VS Code Marketplace (4 steps)

### A1. Build the extension package

```bash
cd vscode-extension
npm install
npm test
npm run package
```

This creates `stats-explorer-mcp-1.1.1.vsix`, which contains your publisher ID from step 0.2.

### A2. Try it in your own VS Code first

1. Open the Extensions view and click **⋯ → Install from VSIX…**, then choose the file.
2. Open a folder with a CSV, switch Copilot Chat to **Agent** mode, and ask: *"Does score differ between the groups in trial.csv?"*
3. Check that:
   - the tools picker (🔧) lists **Stats Explorer**;
   - a form asks you to confirm the columns;
   - the steps run in order.

### A3. Create your publisher

1. Go to <https://marketplace.visualstudio.com/manage> and sign in with your Microsoft account.
2. Click **Create publisher**. Enter the **ID** from step 0.1 exactly (it can't be changed later) and a **Name**, e.g. "Stats Explorer". You can also add a logo, your website and a support email, which appear on your publisher page.
3. Click **Create**.

If the site asks you to create or join an Azure DevOps organization, create a free one. Microsoft uses it for command-line publishing tokens; uploading through the website doesn't need a token.

### A4. Upload

1. On the manage page, select your publisher.
2. Click **+ New extension → Visual Studio Code**.
3. Upload the `.vsix`.

The Marketplace runs an automated scan before the listing goes live, usually within minutes. Then open the listing and check the page: the hero image at the top, then your description, the write-up, the charts and the exploration report.

**Listing tips**

- **Category and keywords:** the listing is in **AI**, **Data Science** and **Chat**, with keywords such as *statistics*, *hypothesis testing*, *t-test* and *anova* (set in `vscode-extension/package.json`).
- **Verified badge:** after your publisher has had an extension on the Marketplace for 6 months, you can verify your website's domain (publisher **Details** tab → **Verified domain**) to get the blue check mark. Your domain must also be at least 6 months old.

**Optional: Cursor, Windsurf and VSCodium users** install extensions from Open VSX, not Microsoft's Marketplace. Create an account at <https://open-vsx.org>, generate an access token, then:

```bash
npx ovsx create-namespace YOUR_PUBLISHER_ID -p <token>   # once
npx ovsx publish stats-explorer-mcp-1.1.1.vsix -p <token>
```

---

## B. Official MCP Registry (5 steps)

The registry stores only metadata pointing at your **npm package**, so the package is published first.

### B1. Publish to npm

Go back to the repository root (`cd ..`) if you're still in `vscode-extension`. Then:

```bash
npm login              # once; turn on two-factor authentication when npm asks
npm publish --access public
```

Check it: <https://www.npmjs.com/package/stats-explorer-mcp> shows version 1.1.1, with the README and images. Running `npx -y stats-explorer-mcp` should print "Stats Explorer MCP server running on stdio" and wait; press Ctrl+C.

### B2. Install the registry's publishing tool

```bash
# macOS / Linux
brew install mcp-publisher
```

On Windows, download `mcp-publisher_windows_amd64.tar.gz` from <https://github.com/modelcontextprotocol/registry/releases/latest>, extract `mcp-publisher.exe`, and put it in a folder on your PATH (or run it from the repository folder).

Check it with `mcp-publisher --help`.

### B3. Sign in with GitHub

```bash
mcp-publisher login github
```

It prints a code. Open <https://github.com/login/device>, enter the code and authorize. Signing in with GitHub is what lets you publish under `io.github.YOUR_GITHUB_USERNAME/...`.

### B4. Publish

From the repository root, where `server.json` is:

```bash
mcp-publisher publish
```

`server.json` already holds everything the registry needs:

- **name:** `io.github.YOUR_GITHUB_USERNAME/stats-explorer-mcp` (must match `mcpName` in `package.json`; it does);
- **description:** up to 100 characters;
- **icon:** the app icon from GitHub;
- **website link** and **repository**;
- the **npm package** and its version;
- the optional settings people can change: `STATS_EXPLORER_ROOTS`, `STATS_EXPLORER_GUIDED`, `STATS_EXPLORER_CONFIRM_SELECTIONS` and `STATS_EXPLORER_HIDE_LINK`.

### B5. Check it

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.YOUR_GITHUB_USERNAME/stats-explorer-mcp"
```

The answer should include your server's name and version 1.1.1. Clients and directories that read the registry pick it up from there.

---

## After publishing

- **Website:** link your site's "For developers" page to the Marketplace listing, the GitHub repository and the npm page. The four images in `docs/images/` can be reused there; they're 1760 px wide, so they stay sharp on high-resolution screens.
- **Claude Code users** can install with `claude mcp add stats-explorer -- npx -y stats-explorer-mcp`.

## Releasing an update

1. If the fix is in the statistics engine, the data import or the Learn-tab workflow text, fix it in the **app** first, then run `npm run sync-engine -- ../path/to/stats-explorer`.
2. Bump the version in **four places**: `package.json`, both `version` fields in `server.json`, and `vscode-extension/package.json`. Add a line to both `CHANGELOG.md` files.
3. Run `npm test`, then `cd vscode-extension && npm test && npm run package`.
4. Publish:
   - commit and `git push`;
   - `npm publish`;
   - on the Marketplace manage page, choose **⋯ → Update** on the extension and upload the new `.vsix`;
   - `npx ovsx publish …` (if you use Open VSX);
   - `mcp-publisher publish`.

## What to keep private

Never share your npm token, Microsoft account, Open VSX token or GitHub login with anyone, human or AI. The repository contains no secrets, and the app's license keys, Stripe and AWS credentials are not involved here.
