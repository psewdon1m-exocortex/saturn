import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DropUploadJobs, type DropUploadJob } from "./drop-upload-jobs.js";

afterEach(cleanup);

it("keeps 4096 individual results accessible with bounded DOM and separates buffer from stored", () => {
  const jobs: DropUploadJob[] = Array.from({ length: 4096 }, (_, index) => ({ id: String(index), name: `файл-${String(index)}.bin`, progress: 1, state: index === 4095 ? "buffered" : "stored" }));
  const remove = vi.fn();
  render(<DropUploadJobs jobs={jobs} label="Results" canRemove={job => job.state === "buffered"} cancelling={new Set()} onRemove={remove} />);
  expect(document.querySelectorAll(".drop-job")).toHaveLength(100);
  expect(screen.getByText("4095 of 4096 stored · 1 waiting for storage")).toBeTruthy();
  for (let page = 1; page < 41; page++) fireEvent.click(screen.getByRole("button", { name: "Next uploads" }));
  expect(screen.getByText("файл-4095.bin")).toBeTruthy();
  expect(document.querySelectorAll(".drop-job")).toHaveLength(96);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(remove).toHaveBeenCalledWith("4095");
  expect(screen.getByRole("button", { name: "Next uploads" }).hasAttribute("disabled")).toBe(true);
});
