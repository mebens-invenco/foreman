import { mount } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";

import App from "./App.svelte";
import "./app.css";

const queryClient = new QueryClient();

const app = mount(App, {
  target: document.getElementById("app")!,
  props: { queryClient },
});

export default app;
