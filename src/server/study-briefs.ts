// Participant-facing task briefs, verbatim from the study design. Kept
// server-side ON PURPOSE: the serial gate must be able to withhold a locked
// task's instructions, so this text can never ship in the client bundle.
// Served by /api/study/task/:id for unlocked tasks only.
export const STUDY_BRIEFS: Record<string, string[]> = {
  "038-S1": [
    "Please implement the browsing and discovery features of a short-term apartment rental website.",
    "Users should be able to browse different types of apartments, search for apartments, and filter apartments based on their criteria.",
    "Use linen as the page background color and maroon as the accent color for components. These are the company's theme colors.",
  ],
  "038-S2": [
    "Continue working on the same short-term apartment rental website.",
    "Add the ability for users to book selected apartments and view their booking records.",
    "Integrate these features into the existing website while preserving its current functionality and visual design.",
  ],
  "098-S1": [
    "Please implement the core browsing and booking features of a comprehensive car rental platform with a user-friendly interface.",
    "Users should be able to browse different types of cars, select rental dates and times, book selected cars, and view their booking records.",
    "Set the page background color to papaya whip and use dark orange for components. These are the company's theme colors.",
  ],
  "098-S2": [
    "Continue working on the same car rental platform.",
    "Add support for multiple payment methods and order management.",
    "Integrate these features into the existing platform while preserving its current functionality and visual design.",
  ],
}
