import { EmptyState } from "@noryx/ui-kit";

export interface ModulePlaceholderProps {
  label: string;
}

/**
 * Stand-in screen for a module that doesn't have a real page yet. Every
 * nav entry in module-registry.ts routes here until it gets its own
 * screen component.
 */
export function ModulePlaceholder({ label }: ModulePlaceholderProps) {
  return (
    <EmptyState
      title={`${label} — coming soon`}
      description="This module screen hasn't been built yet. Adding it is a one-file change: create the screen component and point this route at it."
    />
  );
}

export default ModulePlaceholder;
