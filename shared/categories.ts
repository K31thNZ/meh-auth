// Single source of truth for event categories.
// Used in:
//   - Event creation dropdown (CreateEvent.tsx)
//   - User profile interests selector
//   - Telegram bot /setcategory filter
//   - Notification subscriber filtering

export const EVENT_CATEGORIES = [
  { value: "networking",  label: "Networking" },
  { value: "tech",        label: "Tech & Innovation" },
  { value: "culture",     label: "Arts & Culture" },
  { value: "food",        label: "Food & Drink" },
  { value: "sports",      label: "Sports & Fitness" },
  { value: "music",       label: "Music & Nightlife" },
  { value: "language",    label: "Language Exchange" },
  { value: "outdoor",     label: "Outdoor & Travel" },
  { value: "games",       label: "Games & Hobbies" },
  { value: "business",    label: "Business & Finance" },
  { value: "wellness",    label: "Health & Wellness" },
  { value: "family",      label: "Family & Kids" },
  { value: "social",      label: "Social & Meetups" },
  { value: "volunteering","label": "Volunteering" },
  { value: "other",       label: "Other" },
] as const;

export type EventCategory = typeof EVENT_CATEGORIES[number]["value"];

// For use in Zod schemas
export const EVENT_CATEGORY_VALUES = EVENT_CATEGORIES.map(c => c.value) as [string, ...string[]];

// Helper — get display label from value
export function getCategoryLabel(value: string): string {
  return EVENT_CATEGORIES.find(c => c.value === value)?.label ?? value;
}
