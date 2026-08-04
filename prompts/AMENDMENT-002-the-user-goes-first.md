# Amendment 002 — the user opens the thread, on the Mac, before granting access

**Author:** the planning session. **Date:** 4 Aug. **Status:** approved, unimplemented.
**Amends:** `BOI_ARCHITECTURE.md` § 4.1, `cloud/api/src/welcome.ts`, the signup surface.

## What was found

§ 4.1 currently states that Boi texting first is *"not optional… a correctness fix, not a
growth hack."* The reasoning given is iOS **Filter Unknown Senders**: messages from
non-contacts land in a separate tab with no notification, so if the user had to text
first, Boi would reply perfectly and nobody would see it.

**The failure mode is real. The remedy is backwards.** Apple's documentation:

> An unknown sender is **"anyone you haven't previously interacted with in Messages or
> someone who isn't in your contacts."**

> **"If you respond to a message from an unknown sender, that does not automatically mark
> the sender as known or move the message to your conversation list."**

> "Message filtering doesn't apply to any sender you've replied to three times or more."

Read those together against our current flow: Boi texts first → the user replies with a
pairing code → **Boi is still an unknown sender.** The user's reply does not clear it. We
need three replies, which is most of onboarding conducted in a tab that does not notify.

Whereas a user who *initiates* has "previously interacted," and Boi is known before it
says a word.

The tell was in our own copy. `welcome.ts` reads *"save me so i don't end up in your
filtered messages"* — we are asking the user to do manual work to solve a problem we
created by going first, and the contact card is a mitigation for a self-inflicted wound.

## The candidate fixes

**Keep Boi-first, lean harder on the contact card.** Rejected. It depends on the user
completing a save action before the notification matters, in a thread they have no reason
to trust yet, and Apple explicitly says their reply does not help. It also reads as
unsolicited, which is the thing the user most wants to avoid.

**Invert it: the user opens the thread from a deep link.** Chosen. It satisfies Apple's
"previously interacted" directly, removes the save-the-contact step, and removes the
cold-open posture. It is also the pattern every comparable product uses.

## The delta

| Step | Now | After |
|---|---|---|
| Signup | phone, email, terms | unchanged |
| Immediately after | **server sends first**, with contact card | **register the user with the transport**, resolve their assigned line |
| Confirmation page | `sms:` deep link to a constant number | `sms:` link to **that user's line**, with a **prefilled body** carrying a pairing token |
| First message | Boi → user | **user → Boi**, one tap and send |
| Pairing | 6-digit code typed after the Mac app installs | **the token in the prefilled body** — the code step disappears |
| Contact card | the opening move | **Boi's first reply** — "here, save me", warmer and no longer load-bearing |

## Transport specifics — verify these, do not assume

1. **The allowlist is documented as outbound-only.** *"A shared line will only message
   recipients you've registered as users of your project"*; the rejection is `Target not
   allowed for this project`. Nothing states inbound is filtered. We register the user at
   signup from the number they typed, so they are allowlisted before they tap. **Confirm
   with the vendor** — the whole flow rests on it.
2. **Shared-pool means the number differs per recipient**, so the deep link cannot be a
   constant. Resolve the user's assigned line — create the space and read its `phone`
   without sending — and build the link from that. A "new conversation" is defined as the
   first message the line *sends*, so creating a space should not consume quota. Verify.
3. **Replies inside a user-initiated conversation do not count** against the
   50-new-conversations-per-line-per-day limit, which makes that quota nearly irrelevant
   under this flow.

## Where Full Disk Access slots in — decided: the thread comes first

FDA is the only device-locked step and the highest-friction moment in the product. The
ordering question is really **where the payoff sits relative to the FDA ask**, and the
answer is: never ask a stranger for their entire message history.

`sms:` links open **Messages on macOS**, not only iOS. That makes the whole flow
single-device and removes the cross-device handoff entirely:

```
sign up on the Mac
  -> confirmation page's sms: link opens Messages ON THE MAC
  -> user sends the prefilled message          <- the thread now exists
  -> BOI REPLIES WITH THE DOWNLOAD LINK        <- Boi is useful before it asks
  -> install, grant FDA, sync
  -> the report lands in the thread, already on their phone via iCloud
```

Two properties make this the choice rather than a preference.

**Boi delivers the download link, so Boi is useful before it asks for anything.** The FDA
request then lands as "the thing I already asked for needs this" rather than "a stranger
wants my messages." No other ordering buys that.

**Boi can narrate the grant over iMessage.** `GrantWatcher` already polls every 500ms and
detects the exact moment FDA flips — it has to, because macOS will not apply a TCC grant
to a running process, so the sequence is `deep link → poll → relaunch → verify`. That
machinery is built. Pointed at the thread, the highest-drop-off step in the funnel stops
being a spinner and becomes a conversation:

> *"open System Settings → Privacy & Security → Full Disk Access and drag Boi in. i'll
> tell you when it lands."*
> *"got it. reading your history now — about a minute."*

**This is impossible in any ordering where the thread does not yet exist**, which is the
real argument for putting it first.

The rejected orderings, for the record: signing up on the Mac and granting FDA *before*
the thread asks for everything and delivers nothing; phone-first signup puts a
"now go to your computer" cliff in the middle; and an app-first flow with no web signup
puts FDA closest to a cold start and makes terms consent awkward.

### Register both handles, and this is not optional

**Messages on a Mac frequently sends from the Apple Account email rather than the phone
number.** That is the handle-mismatch trap the vendor's debug line exists to diagnose, and
this flow makes it *more* likely, not less — a Mac is exactly where that misconfiguration
lives. It would present as total silence with no error anywhere.

Signup already collects **phone and email**. Register both with the transport. Then it
does not matter which one Apple sends from. One line, and it converts the largest risk in
this design into a non-event.

## RESULT — tested 4 Aug, and the amendment holds

**Run on a clean device by a third party**, which is the only way it could have failed.
A friend with an iPhone who had **never texted the debug line**, with **Screen Unknown
Senders switched ON**, sent the first message. The reply arrived **in the main
conversation list**, not the filtered view.

So a user who initiates is not an unknown sender, and the deep-link-first flow works.

**The second observation is the confirmation of the other half:** when the *line* initiates
to someone who has not written first, iMessage presents the message with the spam-report
affordance. That is the outcome § 4.1's original design was walking into every single time,
and it is worse than a filtered tab — it puts a "report junk" button under Boi's first
words.

The first attempt at this test was contaminated and worth recording as a method note: the
same handle had been texted earlier the same day, before the filter was enabled. With prior
interaction the reply lands in the main list *because of that history*, so the test would
have passed while proving nothing. **The clean run required a person who had never
contacted the handle** — the test had to be able to fail before its passing meant
anything.

### What remains unverified, and why it does not block

The clean run was sent from a phone, not a Mac, so *"which handle does Messages on a Mac
send from"* is still open. It does not block: the mitigation — **register both the phone
and the email at signup** — is already in prompt `08`, costs one line, and makes the answer
irrelevant. Build it and stop caring which handle Apple picks.

## The five-minute test that settles it

Apple does not publish the exact predicate for "previously interacted," and it is
behaviour that can change.

**Run it the way the flow runs**, which is not the obvious way:

1. On the **iPhone**: Settings → Apps → Messages → **Filter Unknown Senders → ON**.
2. On the **Mac**, in Messages, text the vendor's debug line. **The Mac sends, not the
   phone** — that is the flow being tested.
3. Read the handle the debug bot reports. **This is the second half of the test**: if it
   reports an Apple Account email rather than the phone number, the both-handles
   registration above is load-bearing rather than belt-and-braces.
4. On the **iPhone**, observe the reply: main conversation list or Unknown Senders tab,
   and notification or silence.

**Use a device and number that has never texted or saved that handle.** With prior
interaction the reply lands in the main list because of that history, not because the user
initiated — and the test passes while proving nothing. Confirm it can fail before trusting
that it passed.

One text, and it settles the whole onboarding design.

**If it fails**, the fallback is not the old flow — it is the old flow *plus* the deep
link, so the user still opens the thread and Boi's contact card still arrives first.

## What this does not change

The digest boundary, the three `is_from_me` guards, the drafting layer, the card, the
brief, the scheduler, never-auto-send, and the one-tap remedy rule. This is the signup
surface and the first two messages, nothing below them.

## Implementation

Track E prompt `08`. Prompt `09` adds the on-demand report on top of it. `10` (Spectrum)
then exercises **this** flow on its live send, not the flow it was written against.
