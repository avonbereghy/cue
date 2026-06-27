// Vitest global setup: register @testing-library/jest-dom matchers (e.g.
// toBeInTheDocument) for component tests, and ensure the DOM is cleaned up
// between tests.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
