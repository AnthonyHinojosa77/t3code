---
name: brief-me
description: Show or update the project visual brief, BRIEFME.html, when requested or when project changes make its status stale.
---

# brief-me

`BRIEFME.html` is one page, in the project's main folder, that shows the owner and every agent what the project is, where it is going, where it stands and what happens next. It is built to be easy on the eyes and quick to understand, on a phone and on a computer, with as many good-quality graphics as the project needs.

## When to run

- The user types `/brief-me`: show the existing brief by a link that opens it from chat; if missing, create it and show the link.
- You finished work that changed a project that has a `BRIEFME.html`: refresh it before you report, so it is current for the next person or agent.
- You start work in a project you have not worked in yet: read `BRIEFME.html` first, if it exists, and work from it.

## 1. Gather the facts

Read only real sources, and keep where each fact came from:

- the current `BRIEFME.html`, if any, and the date it was last updated
- the README, project instructions, manifest or lockfile, and the main source folders, enough to name the project's real parts and how they connect
- commits since the brief's last update (`git log`), open work, and check or deployment results you can actually read

Never invent progress, numbers or status. If something cannot be checked, show it as unverified. Facts that come from a conversation rather than a file name that conversation as their source.

## 2. The goal

The goal is where the owner wants the project to end up, in the owner's words. It lives in the brief.

- If the brief already has a goal, keep it word for word. Only the owner changes it.
- If there is no goal in the brief, first look for the owner's stated goal in the current request and project records and reuse their exact words. Only if it remains unknown, ask the owner at most three plain questions, one at a time, about what the finished project should be and do (in the spirit of `grill-me`, if installed). Write the answer in their words. Do not build the rest of the brief on a guessed goal.

## 3. Build the page

Every brief has the same sections, in this order, so the reader always knows where to look:

1. **What changed since last time.** The few changes that matter, newest first. On the first brief, say it is the first brief.
2. **What this project is.** One plain sentence, then a diagram of the project's main parts and how they connect.
3. **The goal.** In the owner's words.
4. **Where it stands.** Each main part with its status in a few plain words used the same way across the page (for example working, partly working, broken, not started, unverified), each with its source. Include a visual of progress from where it is now to the goal.
5. **Next steps.** Only agreed remaining actions, with who does them (the owner, a named agent, or "any agent"). If none remain, say so; do not invent work to fill the section.
6. **Waiting on you.** What only the owner can do or decide, or "Nothing is waiting on you."

Design:

- Load `frontend-design` if available, and follow the project's own design guidance and brand when present. This public skill does not require private toolkit guides.
- Use graphics wherever they make the project easier to see: a map of the parts, a timeline or progress track, status at a glance, flows between components. Draw them as inline SVG or HTML and CSS so they stay sharp on any screen. Every graphic needs text labels; never rely on color alone.
- Plain words only. Define any technical term in plain words the first time it appears. Short sections, generous spacing, comfortable type.
- One self-contained file: inline CSS and SVG, no external scripts, no tracking, no secrets, no build step. The only outside resource allowed is a web-font stylesheet from Google Fonts, always with system font fallbacks so the page reads well without it. It must read well at phone width (about 390px) and on a desktop screen, with no sideways scrolling, in light and dark settings.
- Show "Last updated" with the date at the top.

If the page already exists, keep its look and layout, and update its content. Redesign only when the owner asks.

## 4. Check it

Open the page at phone width and at desktop width and look at it (a headless browser screenshot works). Fix overflow, clipped graphics, unreadable contrast and broken layout before sharing it. If no browser is available, say the visual check was not done.

## 5. Save and share

- Commit `BRIEFME.html` with the project's normal review and delivery rules.
- If publication is authorized by the task and the host supports it, publish this same page there. When the host wraps pages in its own document (claude.ai Artifacts do), publish a copy without the outer `<!doctype>`, `<html>`, `<head>` and `<body>` tags, keeping the title, meta tags, style and content. Reuse the same link on later refreshes: keep it in the page as `<meta name="brief-me-link" content="<url>">` and update that page instead of making a new one. Otherwise, share the saved file through an available link or give its location; do not claim it was published.
- Reply with one message: the link (or file location), the most important change, and what is waiting on the owner.


## Dated updates and finishing a plan

When refreshing the brief after project changes, add a short dated entry: what happened, where things stand, what is next. Keep it generalized, summarized, easy to read, visually clear and forward facing for the owner and agents. Update stale status rather than piling entries over it. Keep personal goals out of project briefs; preserve the existing project-goal step above. Check entries against the owner's words and agreements.

A plan is finished only with evidence that its agreed result happened (a test result, live page or merged change). Record that evidence in the brief; an empty next-steps list is not proof. Report the completed result and agreed remaining work. Give recommendations for new work only when the user requests them; this skill does not establish a standing request. Show the brief by link, never by pasting its text. Copying rules alone does not rewrite other project briefs.
