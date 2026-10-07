import type { Metadata } from "next";
import { DeskApp } from "@/components/desk/DeskApp";
import s from "@/components/desk/desk.module.css";
import { Header } from "@/components/site/Header";

export const metadata: Metadata = {
  title: "Desk",
  description:
    "Ask for an order in plain words or write it as a sentence: Slipway prices every Bitget venue, session and slicing against the live book, gates and signs the plan, and writes dry-run tickets.",
};

export default function DeskPage() {
  return (
    <div className={s.page}>
      <Header current="desk" />
      <DeskApp />
    </div>
  );
}
