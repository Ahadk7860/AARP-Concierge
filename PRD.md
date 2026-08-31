# PRD v2 — AARP iMessage Personal Benefits Concierge

*(Supersedes [PRD-v1.md](PRD-v1.md). The defining additions in v2: atomic per-person
memory, the smart follow-up question system, the gift concierge, behavioral interest
scores, and scoped memory retrieval.)*

## 1. Product Overview

**Product Name:** AARP Concierge

**Vision:** A personal AI assistant inside iMessage that helps members get more value
from their AARP membership. Members text naturally whenever they're eating out, shopping,
buying gifts, planning a trip, renting a car, booking hotels, spending time with
grandchildren, checking Rewards, or just trying to save money. The concierge searches
AARP's benefits, finds the most relevant option, explains it clearly, and sends the
member directly to redeem it.

**The defining feature is memory.** The concierge continuously learns who the member is,
where they live and travel, what they enjoy, who is in their family, what their
grandchildren like, restaurant/hotel/car preferences, typical budgets, what offers they
click and ignore, and what savings actually matter to them. The experience improves every
month. It should feel like: *AARP knows me and is always looking out for me.*

## 2. Core Product Promise

**Behavior 1 — Before You Spend, Ask AARP.** The habit: before I buy something, I text
AARP. ("going to dinner tonight" · "booking a hotel in Boston" · "need Christmas gifts
for the grandkids" · "renting a car in Miami" · "buying flowers for my wife" · "anything
useful at Walgreens?")

**Behavior 2 — Eventually, You Shouldn't Always Have to Ask.** As it learns, the
concierge proactively surfaces opportunities: *"Christmas shopping is coming up. I
remembered Emma and Noah are really into toys and science activities…"* or *"You usually
go to Hawaii around January. Travel prices are looking particularly good right now…"*
A personal savings intelligence layer, not merely a chatbot.

## 3. MVP Objective

Replace the Boi Photon agent with the AARP-branded concierge. Build **P0** (executive
demo) then **P1** (real-user pilot); ignore P2. Prove: discovery, personalization,
engagement, proactive value, and measurable economic value.

## 4. Core Experience

```
Member Message → Understand Intent → Retrieve Relevant Member Memory
→ Search Relevant AARP Benefits → Rank (Intent + Memory + Context) → Respond
→ Ask Smart Follow-Up if Useful → Extract New Memories → Update Profile → Track Outcome
```

Traditional assistant: question → answer. AARP Concierge: question → personalized answer
→ learn something → remember it → use it later.

## 5–7. Benefit Data

Sources: <https://www.aarp.org/membership/benefits/all-offers-a-z/> and
<https://memberoffers.aarp.org/restaurants/> (brand, location, discount, terms,
eligibility, redemption link, category, keywords). Normalized model per benefit with
`discount_type/value`, `member_only`, `keywords`, `audience_tags`, `redemption_url`,
`active`, `last_verified_at`. **Daily refresh**: detect new/expired/changed offers; never
recommend unverified benefits; store `first_seen/last_seen/last_updated/last_verified/
active`. First-party AARP feeds replace scraping in an official deployment.

## 8. Natural Language Search

Members never need AARP terminology. "taking my grandkids somewhere fun" → family,
grandchildren, entertainment, activities, local. "taking my wife somewhere nice tonight"
→ restaurant, date night, higher quality. "need something for the kids for Christmas" →
gifts, grandchildren, toys, holiday.

## 9. Memory Is the Core Differentiator

Not transcripts — a **structured Member Memory System** accumulating: identity (name,
location, style), family (spouse, children, grandchildren — names, approximate ages,
interests), food (cuisines, brands, dining style, price preferences), travel
(destinations, recurring trips, months, hotels, rental cars, companions, style),
shopping (categories, gift recipients, budgets, brands, holiday behavior), interests
(golf, movies, gardening…), benefit behavior (shown/clicked/redeemed/saved/ignored),
and Rewards behavior.

## 10–11. Architecture & Data Model

Railway hosting; PostgreSQL primary store (pgvector optional; no separate vector DB
initially). API service (Photon webhook, conversation runtime, benefit search, member
APIs) + worker (scraper, memory extraction, proactive jobs, watch evaluation).

Core tables: `members` (phone, aarp_member_id, name, timezone, home city/state,
personalization/proactive flags), `memories` — **the heart of the system**:

```
id · member_id · memory_type · subject · value · confidence · explicit ·
user_confirmed · source_message_id · importance_score · created_at ·
last_reinforced_at · expires_at · status
```

e.g. `travel_destination / Hawaii / frequent_destination / 0.94` or
`family_interest / Emma / Barbie / 1.0`.

## 12. Atomic Memories

Never store "John likes Hawaii, has three grandchildren and prefers Marriott." Store
separate memories — *travels to Hawaii · usually in January · prefers Marriott · has
granddaughter Emma · Emma ≈ 6 · Emma likes Barbie · grandson Noah · Noah likes science ·
grandson Lucas · Lucas likes basketball* — so each can be updated, reinforced, forgotten,
expired, retrieved, and ranked independently.

## 13. Memory Types

**Profile** (long-lived facts) · **Behavioral** (learned from actions: clicks travel,
ignores insurance, prefers big savings over proximity) · **Episodic** (Miami trip next
week, Emma's birthday in November — with expiration) · **Relationship** (wife = Susan,
granddaughter = Emma) · **Preference** (hotel = Marriott, cuisine = Italian,
rental_car = SUV, gift_budget ≈ $50).

## 14. Memory Confidence

1.00 explicit and unambiguous · 0.85 strongly inferred · 0.65 moderately inferred ·
0.40 weak · **below 0.40 never proactively used**. Two Honolulu hotel searches →
`possible_destination: Hawaii, 0.55` → ask: *"Do you go to Hawaii often? I can remember
that."*

## 15–16. Reinforcement & Decay

Repeated signals raise confidence (0.55 → 0.93 after repeated golf mentions + clicks).
Decay tiers: permanent (family, home, strong explicit preferences) · slow (favorite
restaurants, hotels, hobbies) · fast (this-weekend needs, holiday shopping).

## 17–19. Smart Follow-Up Question System

The agent asks occasional questions **specifically designed to improve future
recommendations**. Rule: **Answer first. Learn second.** Never hold the useful answer
hostage to personalization questions.

```
FollowUpValue = Future Personalization Utility × Current Uncertainty
              × Likelihood Member Will Answer − Conversation Friction
```

Maximum ≈ one personalization question per meaningful interaction. Examples:
- Dinner search → "Italian, steak, casual, or something else?" (→ cuisine preference)
- "find me somewhere to eat" → "best food, biggest discount, closest, or cheap?"
  (→ `restaurant_priority = quality`)
- "taking my wife out" → "romantic, quiet, or just really good dinner?"
  (→ spouse + date-night style; later feeds Valentine's proactive)
- After an Outback redemption → *"Should I remember that you like Outback, or was this
  a one-off?"* (prevents over-inference)

## 20–23. Gift Concierge (signature experience)

First gift interaction: how many grandkids → names and ages ("I can remember them so
gift ideas get better over time") → what's each into. Store atomically (Emma /
granddaughter / ≈6 / Barbie · Noah / ≈9 / science · Lucas / ≈13 / basketball). Then
recommend per child + relevant AARP shopping offer.

**Budget learning:** "About how much — under $25, ~$50, ~$100, flexible?" → store per-
recipient budget, rank accordingly.

**Interests change fast:** months later — *"Last time Noah was really into science. Still
true, or is he into something different now?"* → decay science, raise soccer.

**Holiday proactive (showcase):** around Thanksgiving — *"Christmas shopping is coming
up. I remembered: Emma likes Barbie, Noah is into soccer, Lucas likes basketball. I found
a few AARP shopping offers… want me to put together some ideas?"*

## 24–33. Travel, Hotels, Cars, Trips, Entertainment

- Broad intent → "warm beach, city trip, nature, cruise, visiting family?" → travel style.
- "somewhere new" → US / Caribbean / Mexico / open (destination discovery).
- Hawaii → remember recurring destination, preferred island (Maui), season; later offer a
  watch.
- Hotel search → afterwards: "Do you usually have a hotel brand you prefer?" →
  `hotel_preference = Marriott, moderate strength, medium price sensitivity` → later:
  *"Marriott option and another $80 cheaper — since you usually prefer Marriott when the
  difference isn't huge, I'd lean Marriott."*
- "going to Florida" → "solo, with your spouse, family, or friends?" (affects everything).
- Car rental → "economy, sedan, SUV, bigger?" then "price, comfort, or luggage space?" →
  later: *"SUV again? Last time you wanted extra luggage space."*
- Family trip to Orlando → "Emma, Noah and Lucas?" → age-spread-aware activities +
  hotel/car/restaurants/attractions checklist.
- "what can we do this weekend?" → "Just you and your wife, or are the grandkids coming?"
- Movies → genre + who's coming; learn per-person tastes over time.
- Golf → "something you play pretty regularly?" → high-confidence interest → relevant
  proactive later.

## 34–38. Shopping, Flowers, Dates, Local

- "need a new TV" → size, then lowest-price vs higher-end (purchasing preference).
- "need flowers for my wife" → "something special or just because?" → anniversary timing,
  spouse-likes-flowers; next year: proactive check-in before the date.
- Important dates (spouse birthday, anniversary, grandchild birthdays, annual vacations)
  — learned naturally, never requested up front.
- "bored today" → "get outside · food · movie/show · something with family · relaxing."

## 39. "Anything Good for Me?" (flagship)

Retrieve time, season, location, family, interests, travel, unused/saved benefits,
Rewards, recent activity → up to three unusually relevant things (Hawaii travel benefit ·
Noah's birthday + soccer gift offer · new Italian offer nearby) → "Which one sounds
useful?"

## 40–41. Transparency

"What do you remember about me?" → clear grouped summary (travel, family, food, shopping)
+ "you can ask me to change or forget anything anytime."
"What am I missing?" → profile × available benefits × history × seasonality → top unused
opportunities.

## 42–45. Savings & Rewards

Savings tracker (per benefit: purchase amount, discount, estimated/confirmed savings) —
"$184 this year: Travel $81 · Dining $72 · Shopping $31." Savings goals ("help me save
$500" → progress + easiest categories to close the gap). Rewards: balance, expiring
points, best redemption **for this member** (learned: gift cards high, sweepstakes low),
earning opportunities.

## 46–49. Proactive Recommendation Engine

Daily worker per opted-in member: profile → active benefits → context → watches →
candidates → personalization score → expected value → interruption cost → send only
above threshold.

```
OfferScore = 30% preference match + 20% context + 15% economic value
           + 10% seasonality + 10% historical behavior + 10% location + 5% novelty
```

Interruption: expected savings × relevance × urgency VS recent frequency + annoyance.
**Max 1 proactive message/week** unless: explicit watch, urgent points expiration,
upcoming-trip trigger, or exceptionally high value. Never an advertising feed.

## 50. Watches

"keep an eye on Hawaii flights" → `{watch_type: travel, destination: Hawaii, conditions:
favorable_price, enabled: true}`. Also: golf deals, toy deals before Christmas, NY
hotels, Orlando rental cars.

## 51–53. Behavioral Learning

`benefit_interactions` (shown/clicked/saved/redeemed/dismissed + estimated savings +
context) feed learning. Initial weights, no ML required:

```
shown 0 · clicked +1 · follow-up +2 · saved +2 · redeemed +4 · "I like this" +5
dismissed −2 · "not interested" −5
```

`member_interests` scores per interest key (explicit + behavior components), e.g.
travel .94 · restaurants .82 · golf .71 · insurance .11.

## 54–56. Scoped Memory Retrieval

Never put every memory in every prompt. "where should we eat?" retrieves location,
cuisines, brands, dining style, family context, price preference, restaurant-benefit
history — not the Hawaii hotel preference or Noah's soccer.

```
MemoryScore = Semantic Relevance × Confidence × Importance × Recency
```

Store concise episodic **conversation summaries** ("Boston trip with spouse; wanted
Marriott-style hotel + SUV; comfort over price; used rental-car benefit").

## 57. Member Control

"forget that" · "don't remember my grandchildren" · "I don't like Marriott anymore" ·
"stop sending restaurant recommendations" · "only send me travel deals" · "stop watching
Hawaii" · "tell me fewer things" · "what do you remember about me?" — memory must remain
transparent and user-controlled.

## 58–59. Photon Implementation & First-Time Experience

Replace Boi. Name: **AARP**. Personality: warm, observant, concise, patient, useful,
trustworthy, **curious without interrogating**, proactive without being annoying.
Natural memory references ("I remember…", "Since you mentioned…", "Last time you…",
"Do you usually…?") — sparingly.

Welcome: *"Hi! I'm your AARP Concierge. I can help you find benefits and savings you
already have through AARP. I'll also get better over time as I learn what you actually
care about. Try: 'Going out to dinner tonight' · 'Need gifts for the grandkids' · 'Going
to Hawaii this winter' · 'I need a rental car' · 'Anything good for me?' Or just tell me
what you're about to buy. — Before you spend, ask AARP."*

## 60–61. P0 / P1 Scope

**P0 (exec demo):** replace Boi · Photon messaging · both scrapers · normalized DB +
daily refresh · semantic + natural-language search · deep links · location · persistent
profiles · **atomic memory DB · extraction · confidence · reinforcement** · family
memory (grandchild names/ages/interests) · food/travel/hotel/car/gift preferences ·
budgets · benefit behavior memory · savings tracker · **smart follow-up questions** ·
"what do you remember?" · "anything good for me?" · "what am I missing?" · watch
prototype · mocked proactive triggers · basic Rewards.

**P1 (pilot):** AARP auth · production memory · correction/deletion · better confidence ·
decay · conversation summaries · Rewards API · saved benefits · trip memory/watches ·
proactive worker · seasonal + birthday triggers · frequency controls · opt-in/out ·
analytics · redemption tracking · real savings history · location-enhanced offers ·
automated ranking.

## 62. Executive Demo Sequence (artificial time jumps)

Day 1 food (romantic Italian → spouse + tastes learned) → Day 5 grandchildren (Emma 6
Barbie · Noah 9 soccer · Lucas 13 basketball) → Day 12 travel (Hawaii every January →
watch) → Day 40 rental (*"SUV again? Last time you wanted extra luggage space."*) →
November Christmas trigger (per-child gift offers) → December Hawaii trigger → "what do
you actually remember about me?" → "how much have you saved me?" ($184: travel/dining/
shopping + one benefit left on the table).

## 63–65. Metrics & Positioning

**North star:** Personalized Member Value Delivered = savings + Rewards value unlocked +
benefits redeemed + relevant opportunities surfaced. **Memory north star:**
personalization lift — generic vs memory-powered recommendations on clicks, redemptions,
savings, repeat usage, proactive engagement.

Position as **"AARP in your contacts"** — a personal AARP concierge that gets to know
you. Hook: *Before you spend, ask AARP.* Long-term: *Eventually, you shouldn't always
have to ask.* Emotional: *The longer you use it, the more useful your membership
becomes.*

## Appendix — Benefit Data Sources

| Source | URL | Notes |
|---|---|---|
| All offers A–Z | https://www.aarp.org/membership/benefits/all-offers-a-z/ | Primary; structured ws.api feeds behind it |
| Restaurant offers | https://memberoffers.aarp.org/restaurants/ | Augeo/Kigo local network; live per-ZIP queries |
