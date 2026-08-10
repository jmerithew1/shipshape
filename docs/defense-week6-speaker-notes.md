# Week 6 Defense — Speaker Notes (mapped to the one-pager)

James's own words, in his voice. Each block is spoken while that one-pager
section is on screen. Companion: docs/defense-week6-onepager.html
(artifact: https://claude.ai/code/artifact/5b23211d-2859-47ad-a756-a6080ea275b6)
and the terraform reading protocol in docs/defense-week6-terraform-map.md.

## HERO — "SHIP → PLATFORM" + the loop diagram (~0:00–0:45)

This week, I'm turning Ship from something I built into something other
developers can actually use and build on.

The way I'm thinking about the project is pretty simple: if someone who has
never seen Ship before can install my SDK, log in, create a document, and get
a notification back confirming it happened — all from my documentation and in
under 30 minutes — then the platform works.

I also automated that same process so it gets tested every time I change the
code. That way, I'm not just saying the developer experience works. I'm
continuously proving it.

(Point at the pills: under 60 seconds in CI, zero flake.)

## 01 — One gate, one shape, one spec (~0:45–2:00)

A lot of my decisions this week came down to the same idea: keep the system
simple and build on what already works instead of adding more pieces just
because I can.

For authentication, Ship already had a way to decide whether someone should
have access. So rather than creating a separate security path for OAuth, I
connected the new login flow back into the system I already had. Whether
someone logs in through the browser or uses an existing token, Ship
ultimately checks access in the same place. That matters because I don't want
different parts of the system eventually disagreeing about who is allowed to
do what.

I took the same approach with the documentation. One thing I wanted to avoid
was the API changing while the documentation stayed outdated. So instead of
writing the API documentation separately, Ship generates it directly from the
API itself. Basically, the same code that defines how the API works also
creates the documentation for it. Then I automatically compare the SDK
against that. If I change the API and forget to update something in the SDK,
the build fails before another developer ever runs into the problem.

## 02 — One Postgres table is the whole webhook system (~2:00–3:00)

For webhooks, I needed to support failed deliveries, retries, delivery
history, and the ability to resend something later. I could have added a
separate queueing system, but that felt like extra infrastructure for a
problem I could already solve with the database.

Every delivery already needs to be saved somewhere, so I made that record do
more work. It keeps track of whether the delivery succeeded, how many times
Ship has tried it, and when it should try again. So for now, the database is
also the queue. If Ship grows to the point where that no longer makes sense,
I can add a dedicated queue later without redesigning the whole system.

I also sign every webhook. In simple terms, that gives the developer
receiving it a way to verify that Ship actually sent it and that the message
wasn't changed along the way.

## 03 — The agent walks in the front door (~3:00–3:50)

The part I find most interesting, though, is what I'm doing with the agent I
built last week. Last week, the agent talked directly to Ship's database. It
worked, but it also gave the agent a shortcut that no outside developer would
have. It could see everything, there weren't meaningful limits around what it
could access, and its actions weren't going through the same system everyone
else would use.

So this week, I'm taking that shortcut away. The agent now has to use Ship
like a real developer does. It has to log in, ask for the permissions it
needs, follow the same usage limits, and every action it takes gets recorded.

I like that because my own agent becomes one of the tests of the platform. If
I have to give my agent special access behind the scenes to make Ship useful,
then I haven't really solved the developer experience yet.

## 04 — Terraform is the recipe; Render is the kitchen (~3:50–4:30)

I followed that same philosophy with the infrastructure: keep it small,
repeatable, and understandable. The entire deployment is described in three
Terraform resources. From a clean machine, I can run the deployment and
recreate the environment from the configuration. I already proved that last
week by destroying the environment and rebuilding it.

For the least-privilege requirement, my hosting provider doesn't use AWS
roles in quite the way the assignment describes, so I applied the idea where
my application actually touches AWS: production secrets. I started with more
access than the service needed and kept removing permissions until it could
do exactly what it needed to do and nothing more. Then I tested that
unrelated actions were blocked. So rather than treating least privilege like
a checkbox, I tested the actual boundary.

## 05 — Deliberately not built + close (~4:30–5:00)

I was also intentional about what I chose not to build. I didn't add a
separate message queue because one server doesn't need one yet. I didn't
spend the week rewriting parts of the application that already worked just to
make the code look cleaner. And I didn't add AI features just to say the
platform has AI. The assignment actually warns against that, and I don't
think it would make the developer experience any better.

My priority was the full developer experience. Someone should be able to find
the API, understand how to use it, log in, use the SDK, create something, get
confirmation that it happened, and understand what went wrong if something
fails. That's really what I'm trying to prove this week.

And I've already thought through what I would cut if I run short on time. I'd
simplify part of the CLI login experience before I cut anything from that
core loop. The architecture can always get more sophisticated later. Right
now, the important thing is that the experience is intuitive, reliable, and
actually works.

## When they hand you the modified terraform plan

Narrate while reading (full crib: docs/defense-week6-terraform-map.md):

"Okay — the summary says X to add, X to change, X to destroy. Anything being
destroyed and recreated is where the risk is, so let me find it… here —
[resource], forced by [attribute]. What that touches: if the database gets
recreated, the data's gone — free tier, no backup — and its connection string
changes, so the web service gets updated and redeployed. If the web service
itself gets recreated, the session secret regenerates and everyone gets
logged out. And one that looks harmless — dropping to the free plan — quietly
kills the background jobs, because free servers go to sleep. Would I apply
this? [yes/no]. If it's already applied: revert the file, apply again."
