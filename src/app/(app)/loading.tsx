// A loading.tsx shows its skeleton only when the segment directly below it changes; search-param changes never do.
// This one covers moving between sections. A section needs its own only when its pages link to each other
// (projects list → project, task → dependency); a leaf page's loading.tsx would never show.
export { PageSkeleton as default } from "@/components/ui";
