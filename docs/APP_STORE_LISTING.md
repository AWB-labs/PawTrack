# Furry Tracker — app store listing copy

Ready to paste into App Store Connect and Google Play Console. Character counts are
shown next to every field with a hard limit — verify against the current store rules
before submitting, in case Apple/Google have changed them.

Reflects the app as it stands today: no vet-booking/appointments feature, no in-app
document library, no Security settings tab. Update this file if that changes.

---

## Apple App Store (App Store Connect)

### Subtitle — 30 characters max
```
Pet care, shared with sitters
```
(29 characters)

### Promotional text — 170 characters max
*Can be changed anytime without a new build/review — good place for what's-new-ish messaging.*
```
Track feeding, meds, weight, and vet visits for every pet. Invite a sitter with exactly the access they need, for exactly as long as they need it.
```
(146 characters)

### Keywords — 100 characters max
*Comma-separated, no spaces after commas, no need to repeat words already in the app name or subtitle.*
```
dog,cat,sitter,caregiver,feeding,medication,vaccination,reminder,tracker,weight,health,record,vet
```
(97 characters)

### Description — 4000 characters max
```
Furry Tracker keeps everyone who looks after your pet on the same page.

Log what matters — feeding, medicine, weight, vaccinations, and vet visit write-ups — for every pet in your home, in one place instead of scattered notes and photos.

SHARE CARE, ON YOUR TERMS
Invite a partner, family member, or sitter to help out. Pick from ready-made presets like View Only, Daily Care, or Full Sitter, or choose exactly what they can see and do. Set a start and end date and their access switches off on its own — no need to remember to revoke it.

EVERYTHING IN ONE RECORD
• Feeding and medicine schedules, with one-tap logging
• Weight tracked over time, with a chart that makes trends obvious
• Vaccination records with due-date reminders before they lapse
• Vet visit write-ups — diagnosis, treatment, cost, and clinic — so nothing gets forgotten before the next appointment
• An activity log, so you can see who logged what, and when

REMINDERS THAT RESPECT YOUR TIME
Get nudged for meals, doses, and upcoming vaccinations — and set quiet hours so they don't interrupt you at night.

BUILT FOR MULTI-PET HOUSEHOLDS
Dogs, cats, rabbits, birds, and more — each pet gets its own profile, its own schedule, and its own record.

Furry Tracker is a record-keeping tool, not a substitute for professional veterinary care. Always consult a licensed veterinarian for anything about your pet's health.
```
(~1,450 characters — well under the limit; left un-padded on purpose)

---

## Google Play Console

### Short description — 80 characters max
```
Track feeding, meds and vet visits — and share care with sitters, safely.
```
(73 characters)

### Full description — 4000 characters max
*Same copy as the App Store description above — Play doesn't have a separate keywords field, so the description itself is what carries search terms like "feeding schedule," "medication reminder," "pet sitter," and "vaccination tracker."*

---

## Notes

- **Privacy Policy / Terms of Service / Support URLs** (both stores ask for these separately, not in the description body):
  - `https://awb-labs.github.io/PawTrack/privacy-policy.html`
  - `https://awb-labs.github.io/PawTrack/terms.html` ← use this as the **EULA / Licence Agreement URL** in App Store Connect, not just as Terms of Service
  - `https://awb-labs.github.io/PawTrack/community-guidelines.html`
  - `https://awb-labs.github.io/PawTrack/support.html`
- **Guideline 1.2 (user-generated content).** The app has a public community feed, so a review will look for five specific things. Where each one is, for the reviewer notes and for the screen recording:
  1. *Agreement with a zero-tolerance clause, before registering or signing in* — tap **Create an account** on the welcome carousel. The rules screen comes before the form, and the form itself carries a required agreement checkbox. Terms §5 is the binding text.
  2. *Filtering* — the composer refuses objectionable text before it is sent, and the database refuses it again (`posts_moderate` / `comments_moderate` triggers).
  3. *Flagging* — the **⋯** control on any post, or **Report** under any comment.
  4. *Blocking* — the same **⋯** control, second row. Blocking is immediate, symmetric, and files a report so we are told why. Undo it in **Settings → Safety**.
  5. *Acting within 24 hours* — published in Terms §5.6 and on the Community Rules page; the operational side is [MODERATION.md](MODERATION.md).
- The vet-care disclaimer at the end of the description is deliberate — Apple has rejected health-adjacent apps for implying medical advice, and it matches the disclaimer already in the Terms of Service.
- If the feature set changes (documents/booking come back, Security tab returns, etc.), update the description before resubmitting — an inaccurate listing is itself a rejection risk.
