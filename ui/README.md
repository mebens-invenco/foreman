# React + TypeScript + Vite + shadcn/ui

This is a template for a new Vite project with React, TypeScript, and shadcn/ui.

## Development

Run UI commands from the Foreman workspace root through pnpm:

```bash
pnpm --filter @foreman/ui dev
pnpm --filter @foreman/ui build
pnpm --filter @foreman/ui typecheck
```

## Adding components

To add components to your app, run the following command:

```bash
npx shadcn@latest add button
```

This will place the ui components in the `src/components` directory.

## Using components

To use the components in your app, import them as follows:

```tsx
import { Button } from "@/components/ui/button"
```
