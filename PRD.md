# PRD — AARP iMessage Personal Benefits Concierge

## 1. Product Overview

**Product Name:** AARP Concierge

**Product Vision:** Turn AARP membership into a personal AI concierge inside iMessage that members can text whenever they are about to spend money, travel, eat out, shop, plan something with family, or simply want to know what their membership can do for them.

The concierge learns who the member is over time — their preferences, family, favorite destinations, restaurants, hobbies, upcoming trips, recurring purchases, benefits they use, benefits they ignore, and the types of savings they care about.

Instead of requiring members to search AARP's website or app:

> Member asks → AARP understands the member + current need → finds the most relevant benefit → explains it simply → sends the member directly to redeem it → remembers the interaction → becomes better next time.

Eventually, the member should not always have to ask. The concierge proactively identifies highly relevant opportunities based on what it has learned.

**Product Promise:** *AARP knows what matters to you and is always looking out for ways your membership can help.*

## 2. Core Product Principles

Two behavioral loops:

**Loop 1 — Before You Spend, Ask AARP.** Not "search AARP benefits" but "before you spend money, ask AARP." Members speak naturally:

- "I'm going to Orlando next month"
- "Any restaurant discounts near me?"
- "Renting a car tomorrow"
- "I'm buying flowers for my wife"
- "Going to Outback tonight"
- "Need a hotel in Boston"
- "Do I get anything at Walgreens?"
- "What's the best discount I haven't used?"

The member never needs to know the official name of an AARP benefit.

**Loop 2 — Eventually, AARP Knows When to Ask You.** The longer a member uses the concierge, the more useful it becomes. AARP gradually learns: where they live, frequent travel destinations, favorite restaurants and cuisines, hotel brands, hobbies, family members, grandchildren and their interests, spouse preferences, upcoming trips, important dates, recurring purchases, shopping interests, benefits previously used or ignored, Rewards preferences, and what kinds of savings they care about.

This reverses benefit discovery:

```
Today:            User has need → remembers AARP → searches AARP → finds benefit
AARP Concierge:   AARP understands user → relevant situation occurs → concierge
                  recognizes opportunity → AARP proactively surfaces benefit
```

## 3. MVP Objective

Build a production-quality prototype of an AARP-branded AI iMessage agent using Photon. Replace the existing Boi agent/account on Photon with the AARP experience.

The MVP proves four things:

1. **Discovery** — members find relevant AARP benefits dramatically faster through conversation.
2. **Personalization** — the concierge becomes noticeably better as it learns the member.
3. **Engagement** — members return repeatedly because it remembers them and surfaces relevant value.
4. **Economic Value** — AARP can quantify how much membership value the concierge surfaces per member.

## 4. Primary User Loop

1. **Member sends an intent** — e.g. "I'm going to dinner tonight"
2. **Agent understands the situation** — extract intent, location, date/time, relevant preferences, family context, previous behavior, membership status if linked. If needed: "Happy to help. What city or ZIP code are you in?"
3. **Retrieve member memory** — e.g. lives in Boston, likes steakhouses, previously used Outback benefit, often eats out on weekends, prefers options within 5 miles.
4. **Search verified AARP benefits** — national, local, restaurants, travel, hotels, rental cars, shopping, entertainment, home, auto, technology, wellness, other membership benefits.
5. **Rank recommendations** by: current intent, personal preference, estimated savings, proximity, eligibility, timing, historical behavior, redemption simplicity, novelty.
6. **Show only the best options** — never dump 20 results:
   > I found 3 good options near you: Outback — 10% off · Denny's — 15% off · Cicis — 15% off. Since you liked Outback last time, that's probably your best match. Want the offer?
7. **Redemption** — offer card with title, terms summary, and "Use benefit →" [AARP deep link].
8. **Track value** — "Did you use it?" → "About how much was the bill?" → "$82" → "That's roughly $8 saved. You've saved about $67 with AARP this year."
9. **Update memory** — member uses restaurant benefits, likes Outback, responds to dining savings; estimated dining savings increased. Every useful interaction makes the next one better.

## 5. Benefits Data Engine

### Source 1 — AARP All Benefits (A–Z)

Initial ingestion: <https://www.aarp.org/membership/benefits/all-offers-a-z/>

Supplementary discount landing page: <https://www.aarp.org/membership/lp/promo/26ld-e/>

Ingest and normalize every benefit:

```json
{
  "id": "outback-steakhouse",
  "brand": "Outback Steakhouse",
  "title": "10% off",
  "description": "10% off dine-in or curbside carryout orders placed by phone",
  "category": "restaurants",
  "discount_type": "percentage",
  "discount_value": 10,
  "member_only": true,
  "redemption_method": "AARP member benefit",
  "offer_page_url": "https://www.aarp.org/benefits-discounts/all/outback-steakhouse/",
  "redemption_url": "https://www.aarp.org/benefits-discounts/all/outback-steakhouse/?intcmp=...",
  "outlink_url": "https://www.outback.com/...",
  "location_restricted": false,
  "keywords": ["steak", "restaurant", "dinner", "food", "outback"],
  "last_verified_at": "..."
}
```

### Source 2 — Restaurant Offers

Ingest: <https://memberoffers.aarp.org/restaurants/>

(Note: the entry URL carries `code`/`state` query tokens that may be session-scoped and expire — the scraper should establish its own session against the base path.)

Include: national chains, local restaurants, location data, discount amount, redemption rules, participation restrictions.

### Source 3 — Other Benefit Categories

Travel, hotels, rental cars, cruises, restaurants, groceries, shopping, entertainment, health & wellness, insurance, financial services, technology, home, auto, local offers.

### Outlinks Are Required on Every Benefit

Every ingested benefit **must** carry working outlinks — a benefit without a link the member can tap is not shippable. For each benefit, the scraper captures:

- **`offer_page_url`** — the AARP offer detail page (canonical source of terms; always exists).
- **`redemption_url`** — the AARP-hosted "use this benefit" link (may require member login; this is the primary deep link sent in iMessage).
- **`outlink_url`** — the final outbound partner destination (e.g. the partner's booking/order page), when AARP exposes one.

Rules:

1. Every recommendation message includes a tappable link ("Use benefit →") pointing at `redemption_url`, falling back to `offer_page_url` if no redemption link exists.
2. Outlinks are validated during ingestion and daily refresh (HTTP status + redirect resolution). A benefit whose links 404 or redirect to a generic page is marked `active: false` and never recommended.
3. Preserve AARP's own attribution/campaign parameters on redemption links where present (so redemptions are trackable), but strip third-party tracking junk (`gclid`, `adobe_mc`, etc.).
4. Never fabricate or guess a URL — links come only from scraped/ingested data.

## 6. Benefit Refresh System

Run ingestion daily. Detect: new benefits, removed benefits, changed discounts, changed redemption URLs or outlinks (including link rot — 404s and dead redirects), changed eligibility, changed terms.

```
Outback Steakhouse
Previous: 10%  →  Current: 15%
CHANGE DETECTED
```

Each benefit stores: `first_seen`, `last_seen`, `last_updated`, `last_verified`, `active`.

Never continue recommending an offer that can no longer be verified. For an official AARP deployment, scraping should ultimately be replaced where possible by first-party APIs, feeds, CMS exports, or other approved structured sources.

## 7. Semantic Benefit Search

Users should not need AARP's terminology.

- "taking the grandkids somewhere fun this weekend" → intent: family entertainment → retrieve theme parks, movies, attractions, local activities, family entertainment, relevant shopping/dining.
- "heading to Miami for four days" → search hotels, rental cars, restaurants, activities, travel benefits.

The system reasons over benefits, not keyword-searches them.

## 8. Memory Is a Core Product System

Memory is a first-class product capability. Every meaningful conversation makes AARP Concierge slightly better at understanding the member.

Example — February: "Going to Hawaii next month" → learn destination Hawaii, interest travel, possible recurring frequency; relevant categories hotels, flights, rental cars, restaurants. Months later:

> I remember you like going to Hawaii. I found something that could make your next trip cheaper. Want to see it?

The member should not need to repeatedly explain the same preferences.

## 9. Member Memory Profile

```json
{
  "home_location": "San Francisco, CA",
  "travel_preferences": {
    "destinations": [
      {"destination": "Hawaii", "confidence": 0.91, "frequency": "often"},
      {"destination": "New York", "confidence": 0.72}
    ],
    "hotel_preferences": ["Marriott"],
    "travel_style": "leisure"
  },
  "family": {
    "has_grandchildren": true,
    "grandchildren_interests": ["toys", "Disney", "science activities"]
  },
  "food_preferences": {
    "cuisines": ["Italian", "steakhouses"],
    "brands": ["Outback Steakhouse"],
    "dining_frequency": "weekly"
  },
  "shopping_preferences": {"categories": ["gifts", "electronics", "home"]},
  "interests": ["golf", "movies", "travel"],
  "benefit_behavior": {
    "frequent_categories": ["restaurants", "travel"],
    "previously_used": [],
    "saved": [],
    "ignored": []
  }
}
```

Do not require the member to manually build this profile — it emerges naturally.

## 10. Memory Types

- **Profile Memory** (long-lived): lives in Chicago, has grandchildren, likes golf, prefers Italian, usually stays at Marriott, travels to Hawaii frequently.
- **Behavioral Memory** (learned from usage): frequently searches restaurant discounts, clicks travel offers, prefers high-dollar savings, rarely interacts with insurance benefits, tends to use AARP while traveling.
- **Episodic Memory** (currently happening, expires naturally): Hawaii trip March 12–19, granddaughter's birthday next month, rental car needed tomorrow, Christmas shopping beginning, visiting grandkids in Orlando.
- **Benefit Memory**: shown / clicked / saved / redeemed / dismissed / ignored / estimated savings. Avoid recommending the same irrelevant thing repeatedly.
- **Rewards Memory**: current points, earning patterns, redemption preferences, previously selected rewards, expiring points.

## 11. Memory Confidence

Distinguish explicit facts from inferred preferences.

- **Explicit** — "I go to Hawaii every winter." → high confidence.
- **Inferred** — member searches Hawaii hotels twice → medium confidence.

Do not immediately state "You love Hawaii." Instead:

> It looks like Hawaii might be somewhere you travel often. Want me to keep that in mind?

Memory should feel useful, not creepy.

## 12. Preference Learning

Every action is a signal.

- **Positive** (increase confidence): clicks, saves, redeems, follows up, asks for similar offer, says recommendation was useful.
- **Negative** (decrease confidence): ignores repeatedly, dismisses, says not interested, asks to stop category.

The recommendation model improves continuously.

## 13. Trip Mode

Travel is a showcase use case.

> Member: Going to Miami next week
> AARP: Nice — I can help check your AARP benefits for the trip. 🏨 Hotels · 🚗 Rental cars · 🍽️ Restaurants · 🎟️ Things to do. What do you still need?
> Member: rental car and restaurants

The concierge searches relevant categories, then remembers: trip = Miami, date = next week, needs = rental car + restaurants. The trip becomes useful context for future messages.

## 14. Persistent Trip Memory

```json
{
  "destination": "Hawaii",
  "travelers": ["spouse"],
  "approximate_dates": "January",
  "frequency": "annual",
  "hotel_preferences": ["Marriott"],
  "interests": ["beach", "restaurants"],
  "watch_enabled": true
}
```

The agent can later reason: Hawaii preference + January travel pattern + Marriott preference + AARP hotel benefit + good travel opportunity.

## 15. Watch Mode

Members explicitly ask AARP to watch for opportunities: "Tell me when there are good Hawaii deals." / "Keep an eye out for hotel discounts in New York." / "Let me know about golf offers." / "Watch rental cars for Florida."

```json
{
  "watch_type": "travel",
  "destination": "Hawaii",
  "trigger": "meaningfully_good_opportunity",
  "active": true
}
```

The concierge can then proactively contact the member.

## 16. Proactive Intelligence

The defining experience. Continuously combine:

```
Member Memory + Current Context + AARP Benefits + Time/Season + Location + Relevant External Signals
```

Ask: *Is there something useful enough to tell this member right now?* Most of the time: no. When yes, it should feel surprisingly personal.

## 17. Example — Grandchildren + Christmas

Months earlier: "Taking my grandkids shopping. They love Legos and toys." → store has-grandchildren, interests toys/LEGO.

Around Thanksgiving — holiday shopping season + relevant shopping offer + grandchildren interest + high relevance:

> Christmas shopping season is coming up, and I remembered your grandkids are into toys. I found an AARP offer that might be useful for gifts this year. Want to see it?

Target reaction: *"Wow, AARP remembered."*

## 18. Example — Hawaii

Prior: "We usually go to Hawaii every winter." → destination Hawaii, frequency annual, season winter. Later, if relevant travel-pricing information is available:

> You mentioned you usually visit Hawaii in the winter. Travel prices are looking particularly good right now, and you also have AARP benefits that could help with the trip. Want me to check options?

Fundamentally different from "Check out our travel benefits!"

## 19. Example — Family Travel

Memory: has grandchildren, grandchildren live near Orlando, member sometimes visits Orlando. Later:

> I remember you sometimes visit the grandkids in Orlando. There are AARP hotel and rental-car benefits that could help with another trip. Want me to keep an eye out for good opportunities?

## 20. Temporal Intelligence

Understand moments: Thanksgiving, Christmas, Valentine's Day, birthdays, anniversaries, summer travel, upcoming trips, Rewards expiration, membership renewal.

Member previously says "My wife loves flowers." Before Valentine's Day:

> Valentine's Day is coming up. I remembered you mentioned your wife likes flowers. I found an AARP offer that might help if you're planning something. Want it?

## 21. Nearby Savings

> Member: food discounts near me

If location unavailable: "Send me your ZIP code or location and I'll find the best nearby AARP offers." Then:

> Here are the best nearby: Denny's — 0.8 mi, 15% off · Outback — 1.7 mi, 10% off · McAlister's — 2.1 mi, 10% off. Since you've used steakhouse offers before, Outback might be your best match.

## 22. Savings Tracker

**My AARP Savings**: estimated savings this year ($184), benefits used (12), top category (Restaurants — $72), membership cost recovered (12.3×).

> Member: how much have I saved?
> AARP: You've saved about $184 this year 🎉 Travel — $81 · Dining — $72 · Shopping — $31. Based on what I know about you, travel is probably where you still have the most unused value.

The savings tracker itself is intelligent.

## 23. AARP Rewards

The concierge is the conversational interface for AARP Rewards: "how many points do I have?" / "what's expiring?" / "what can I redeem?" / "what's the best thing I can get?" / "how can I earn more?"

> You have 18,450 AARP Rewards points. About 2,300 expire soon. You usually seem most interested in gift cards. Want me to show you the best available options?

## 24. Rewards Earning Recommendations

> Member: how can I earn points today?
> AARP: I found a quick eligible activity that earns Rewards points. Earn points →

Learn which earning activities a member actually engages with.

## 25. Rewards Expiration

> Heads up — 2,800 Rewards points expire next month. You usually use your points for gift cards, and I found a few options worth checking. Want to see them?

Combines Rewards with memory.

## 26. "What Am I Missing?"

> Member: what AARP benefits am I not using?

Compare available benefits vs. member profile vs. previous benefit usage vs. current context:

> Based on what I know about you, these are probably your biggest unused opportunities:
> **Travel** — you go to Hawaii regularly but haven't used your rental-car benefit.
> **Dining** — you eat out often and there are participating restaurants near you.
> **Shopping** — you mentioned buying gifts for your grandchildren, and there's a relevant shopping benefit.
> Want to start with one?

## 27. "Anything Good for Me?"

A flagship memory demonstration.

> Member: anything good for me right now?
> AARP: Two things stand out:
> **Hawaii travel** — since you like going to Hawaii, there's a travel benefit worth checking before your next trip.
> **Grandkids** — holiday shopping is coming up, and I found an offer related to gifts that might be useful.
> Which one should I show you?

Traditional search cannot answer this well. Memory can.

## 28. Before You Buy Mode

Teach: *Before you buy, text AARP.* — "buying flowers", "renting a car", "booking a hotel", "getting dinner", "need a new phone", "booking a cruise".

The agent checks member context + benefits. If none applies:

> I couldn't find an AARP benefit that clearly applies right now.

Never hallucinate savings.

## 29. Saved Benefits

> Member: save that → store. Later: what did I save?
> AARP: You have 4 saved benefits: Outback — 10% off · Denny's — 15% off · Papa John's — 20% off · Rental-car benefit. Your Miami trip is coming up, so the rental-car benefit is probably the most relevant right now.

Saved benefits participate in personalization.

## 30. Personalized Ranking

```
BenefitScore =
  30% current intent relevance
+ 20% member preference relevance
+ 15% estimated economic value
+ 10% timing relevance
+ 10% location relevance
+ 10% historical engagement likelihood
+  5% novelty
```

Prefer *highly relevant to this person* over *generically popular with AARP members*.

## 31. Contextual Triggers

Potential triggers: new relevant AARP offer · saved benefit changes · Rewards points nearing expiration · known trip approaching · holiday matches member interests · frequently used category receives new benefit · travel opportunity matches watched destination · member reaches savings milestone.

A trigger does not automatically generate a message — every trigger must pass a relevance threshold.

## 32. Interruption Score

```
(Expected Member Value × Personal Relevance × Urgency)
                    VERSUS
(Messaging Frequency + Potential Annoyance)
```

A $3 opportunity probably does not deserve a proactive message. A $150 travel saving might.

## 33. Proactive Messaging Philosophy

The product dies if it becomes marketing spam. Default: **high relevance, low frequency.**

Ideal reaction: "AARP remembered something that was actually useful."
Bad reaction: "AARP is sending me ads."

Optimize for *useful proactive interactions per member*, not messages sent.

## 34. Member Controls

Conversational personalization control: "don't send restaurant offers" · "only tell me about travel" · "stop watching Hawaii" · "tell me fewer things" · "remind me about this in December" · "don't remember that" · "forget that I like Outback" · "what do you remember about me?"

> Member: what do you remember about me?
> AARP: A few things you've told me that help me find better benefits:
> • You like visiting Hawaii.
> • You have grandchildren who like toys.
> • You often look for restaurant savings.
> • You prefer Marriott when traveling.
> You can ask me to change or forget any of these anytime.

Trust and control are mandatory.

## 35. Family Memory

Relationship types: spouse, children, grandchildren, parents, pets. Examples: "Grandson likes dinosaurs." · "Granddaughter is starting college." · "Wife likes flowers." · "Family visits Orlando."

Only remember information reasonably useful for benefit personalization.

## 36. Optional Lightweight Onboarding

No long questionnaire. After delivering some initial value:

> Want me to personalize what I find for you? → What would you most like me to help with? (Travel / Restaurants / Shopping / Entertainment) → Anywhere you travel often?

Everything else is learned naturally.

## 37. Membership Identity

- **Anonymous Mode** — generic benefit questions work without authentication ("What discount do I get at Denny's?").
- **Linked Member Mode** — authentication required for: Rewards balance, personalized Rewards, saved benefits, savings history, member-specific eligibility, persistent personalized profile.

Flow:

> I can show you that once I securely connect this number to your AARP account. Connect my AARP account →

**Never request passwords over iMessage.**

## 38. Additional Wow Features

- **Screenshot Search** — user sends a screenshot ("I'm about to book this"); agent identifies the merchant/hotel/product and checks benefits.
- **Forward-to-AARP** — member pastes "Hertz rental $384" → "Before you book — you may have an AARP rental-car benefit. Want me to check?"
- **Savings Goal** — "help me save $500 this year" → track $184 / $500; use memory to identify the most realistic path.
- **Weekly Savings Digest** (opt-in) — "You saved approximately $19 this week. I also found one new benefit that matches something you've told me you're interested in. Want to see it?"
- **Household Mode** — "Does this benefit work for my husband too?" → explain household-member eligibility.
- **Voice Notes** — transcribe and handle normally.
- **Human Help** — "talk to someone" → immediately provide correct support path. Never force users to fight the bot.

## 39. Safety and Accuracy

- **Never invent benefits** — every recommendation originates from verified benefit data.
- **Display important restrictions** — participating locations, member login, minimum purchase, phone orders, online redemption, eligibility.
- **Internally source every recommendation** — attach `benefit_id`, `source_url`, `last_verified`, `offer_terms`.
- **Memory accuracy** — allow correction and deletion; do not treat weak inference as confirmed fact.

## 40. Photon Implementation

Replace the current Boi Photon implementation.

- **Display name:** AARP
- **Profile:** official approved AARP branding.
- **Personality:** warm, concise, knowledgeable, observant, trustworthy, clear, proactive without being pushy, appropriate for older adults without sounding patronizing.

Use references to memory naturally ("Since you mentioned…", "I remembered…", "Since you usually…") — not excessively.

## 41. Recommended Architecture

```
                         AARP Website
                              │
                              ↓
                        Benefits Ingestion
                              │
                              ↓
                        Benefits Database
                              │
                       Semantic Retrieval
                              │
                              ↓
User ←→ iMessage ←→ Photon ←→ AARP Concierge
                              │
              ┌───────────────┼──────────────────┐
              ↓               ↓                  ↓
          Member Memory    Benefits Engine    Rewards
              │               │                  │
              └───────────────┼──────────────────┘
                              ↓
                      Recommendation Engine
                              │
              ┌───────────────┼──────────────────┐
              ↓               ↓                  ↓
          Watch Engine     Savings Tracker    Analytics
```

## 42. Core Backend Services

- `benefits_ingestion` — import and normalize benefits.
- `benefits_search` — `search_benefits(query, member_context, category, location, timing)`
- `member_memory` — `get_member_memory()`, `store_memory()`, `update_memory_confidence()`, `delete_memory()`
- `rewards_service` — `get_points_balance()`, `get_expiring_points()`, `get_rewards()`, `get_earning_opportunities()`
- `savings_service` — `record_benefit_used()`, `estimate_savings()`, `get_total_savings()`
- `watch_service` — `create_watch()`, `delete_watch()`, `evaluate_watches()`
- `recommendation_service` — `generate_candidates()`, `rank_for_member()`, `calculate_interruption_score()`
- `analytics_service` — track all product and business outcomes.

## 43. Memory Architecture

Core objects: `Member`, `ProfileMemory`, `Preference`, `Relationship`, `Interest`, `Place`, `UpcomingEvent`, `Trip`, `Watch`, `BenefitInteraction`, `RewardInteraction`, `SavingsEvent`.

Each memory carries: `value`, `confidence`, `source`, `created_at`, `last_reinforced_at`, `expiration_date`, `user_confirmed`, `active`.

## 44. Memory Extraction Pipeline

```
Incoming Message
       ↓
Intent Detection
       ↓
Retrieve Member Memory
       ↓
Benefit Search / Agent Response
       ↓
Memory Extraction
       ↓
Confidence Evaluation
       ↓
Member Profile Update
```

Example: "Taking the grandkids to Disney next month." → `relationship = grandchildren`, `destination = Disney/Orlando`, `trip_time = next month`, `interest = family travel`.

## 45. Recommendation Engine

For opted-in users:

```
for each member:
    retrieve memory
    retrieve active benefits
    retrieve contextual triggers
    generate candidate recommendations
    calculate relevance
    calculate expected member value
    calculate interruption cost
    if recommendation_score > threshold:
        send
```

## 46. Redemption Tracking

```
benefit_shown → benefit_clicked → redemption_started → redemption_confirmed → estimated_savings
```

Over time, this also becomes behavioral memory.

## 47. Analytics Dashboard

- **Adoption:** activated members, DAU/WAU/MAU, repeat usage, conversations/member.
- **Discovery:** benefits surfaced, unique benefits discovered, search success rate, top categories.
- **Conversion:** clicks, redemption intent, redemptions, conversion by offer.
- **Member Value:** total estimated savings, savings/member, benefit usage, partner transaction value influenced.
- **Rewards:** balance queries, points redeemed, expiration prevented, Rewards activity.
- **Memory:** memories/member, confirmed preferences, memory corrections, memory deletions.
- **Recommendation Quality:** proactive recommendations sent, replies, clicks, redemptions, dismissals, unsubscribe / "stop suggestions" rate.
- **Personalization Lift:** generic vs. memory-personalized recommendation performance — engagement, click-through, redemption, savings generated.

## 48. First-Time Experience

> Hi! I'm your AARP Concierge 👋
> I can help you find benefits and savings you already have through AARP. I'll also get better over time as I learn what you actually care about.
> Try:
> "Going out to dinner tonight" · "I'm going to Hawaii next month" · "Taking the grandkids out this weekend" · "What discounts do I have near me?" · "Keep an eye out for hotel deals in Florida."
> Or just tell me what you're about to buy.
>
> Tip: Before you spend, ask AARP.

## 49. P0 — Executive Demo

Build immediately:

- Replace Boi with AARP on Photon; AARP persona and profile
- All-offers scraper; restaurant-offers ingestion; structured benefit database; benefit refresh
- Semantic search; natural-language querying; location/ZIP support; deep links
- Member profiles; persistent conversational memory; preference extraction; family memory; travel memory; benefit interaction memory; memory confidence
- Simple savings tracker; personalized ranking
- Manual/mock proactive triggers; Watch Mode prototype
- "What do you remember about me?" · "What benefits am I missing?" · "Anything good for me?"
- Basic saved benefits; basic trip tracking

The executive demo should deliberately span multiple simulated dates to prove persistence.

## 50. P1 — Pilot

Add: AARP member authentication; production-grade persistent member memory; memory correction/deletion; saved interests; configurable Watches; AARP Rewards balance, preferences, points expiration, and recommendations; automated benefit refresh; real proactive recommendation engine; consent and frequency controls; real contextual triggers; better local search; analytics dashboard; redemption tracking; trip tracking; deeper personalization; savings history; proactive savings milestones.

## 51. Executive Demo Script

**Scene 1 — Immediate Savings**
> Member: going to outback tonight
> AARP: Good timing — your AARP membership can currently save you 10% on eligible Outback orders. Want the benefit?
> Member: yes
> AARP: Use your Outback benefit → If you use it, tell me what you spent and I'll keep track of your savings.

**Scene 2 — Establish Family Memory**
> Member: taking my grandkids shopping today. they're obsessed with toys right now
> AARP: Sounds fun. I'll check whether you have any useful shopping benefits. I'll also keep in mind that toy deals can be useful when you're shopping for the grandkids.

**Scene 3 — Establish Travel Memory**
> Member: thinking about Hawaii again this winter
> AARP: I remember Hawaii is one of your regular trips. Want me to keep an eye out for AARP travel benefits or particularly good opportunities?
> Member: yes
> AARP: Done. I'll only reach out when something looks genuinely worthwhile.

**Scene 4 — Proactive Hawaii Trigger** (weeks later)
> AARP: You asked me to watch Hawaii trips. There's a travel opportunity worth checking right now, and one of your AARP benefits could help too. Want me to pull it up?

**Scene 5 — Thanksgiving Memory** (months later)
> AARP: Christmas shopping is coming up. I remembered your grandkids are into toys, and I found an AARP offer that might be useful for gifts. Want to see it?

**Scene 6 — Rewards**
> Member: what about my points
> AARP: You have 18,450 Rewards points, including 2,300 expiring soon. You usually seem most interested in gift cards. Want me to show you the best ones available?

**Scene 7 — Demonstrate Memory**
> Member: what do you actually remember about me?
> AARP: Mainly things you've told me that help me find better benefits: • You like visiting Hawaii. • You have grandchildren who are into toys. • You often look for travel savings. • You've used restaurant benefits a few times. You can ask me to change or forget any of these anytime.

**Scene 8 — Membership ROI**
> Member: how much have i saved
> AARP: I've helped you find about $184 in savings this year 🎉 Travel — $81 · Dining — $72 · Shopping — $31. There's also one high-value travel benefit you're not using yet. Want to see it?

## 52. North-Star Metric

**Personalized Member Value Delivered** = savings attributable to concierge + Rewards value unlocked + benefits discovered + redemptions driven.

Key question: *Do members using AARP Concierge extract materially more value from their AARP membership?*

## 53. Secondary North-Star — Memory Lift

How much better does the product perform because it knows the member?

```
Generic Recommendation CTR:              8%
Memory-Personalized Recommendation CTR: 24%
```

Compare: click-through, benefit usage, redemption, estimated savings, repeat engagement.

## 54. Product Positioning

Not "AARP discount search over iMessage." Not "a chatbot."

**Position as:** *AARP in your contacts* — an AARP concierge that gets to know you.

**Supporting statement:** AARP Concierge learns what matters to each member and proactively finds the benefits, savings and rewards that are most relevant to their life.

- **Behavioral promise:** Before you spend, ask AARP.
- **Long-term promise:** Eventually, you shouldn't always have to ask.
- **Emotional promise:** The longer you have it, the more useful your AARP membership becomes.

## Appendix — Benefit Data Sources

| Source | URL | Notes |
|---|---|---|
| All offers A–Z | https://www.aarp.org/membership/benefits/all-offers-a-z/ | Primary ingestion target; full benefit catalog |
| Discounts landing page | https://www.aarp.org/membership/lp/promo/26ld-e/ | Supplementary; marketing LP (tracking params stripped) |
| Restaurant offers | https://memberoffers.aarp.org/restaurants/ | Location-aware restaurant catalog; entry-URL `code`/`state` tokens are session-scoped — scraper must establish its own session |
