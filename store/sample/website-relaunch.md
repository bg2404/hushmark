---
title: Website relaunch
owner: Design team
status: In progress
due: 2026-11-28
---

# Website relaunch

The new site goes live on **28 November**. This page tracks what is left, who owns it, and the decisions we have already made, so nobody has to dig through chat threads to find them.

## Milestones

| Milestone | Owner | Due | Status |
|:----------|:------|:---:|-------:|
| Content audit | Editorial | 31 Oct | Done |
| New navigation | Design | 7 Nov | Done |
| Accessibility pass | Engineering | 14 Nov | In review |
| Launch checklist | Everyone | 21 Nov | Open |

## This week

- [x] Approve the new colour palette
- [x] Move the blog to the new templates
- [ ] Write redirects for the old product pages
- [ ] Test the contact form on mobile
- [ ] Book the launch-day check-in

## Decisions

> Keep the URL structure flat. Every page is at most two clicks from the home page, and old links redirect instead of breaking.

1. Ship the light theme first; the dark theme follows in December.
2. Images are served at three sizes, never larger than the layout needs.
3. Analytics stay off until the cookie banner has been reviewed.

### Redirect rules

```nginx
location /products/legacy/ {
    return 301 /products/;
}
location = /about-us {
    return 301 /about;
}
```

## Open questions

- Do we keep the old *press kit* page, or fold it into **About**?
- Who signs off the final copy on the pricing page?

---

Last updated by the design team. Edit this file directly; it is the source of truth for the relaunch.
