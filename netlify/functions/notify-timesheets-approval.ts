// netlify/functions/notify-timesheets-approval.ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

const TIMESHEETS_HOURLY_EMPLOYEES: Record<string, string> = {
  "Cameron Jones": "394589",
  "Will Alterman": "397667",
};

interface TimeOffRecord {
  id: number;
  person: string;
  start_date: string;
  end_date: string;
  hours?: number;
  status: string;
  note?: string;
  requested_by?: string;
}

export const handler = async (event: any) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const payload: TimeOffRecord = JSON.parse(event.body || "{}");
    const { id, person, start_date, end_date, hours, status, note, requested_by } = payload;

    if (status !== "Approved" || !TIMESHEETS_HOURLY_EMPLOYEES[person]) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          skipped: true,
          reason: !TIMESHEETS_HOURLY_EMPLOYEES[person] ? "Not hourly employee" : "Not approved status",
        }),
      };
    }

    const { data: existing } = await supabase
      .from("timesheets_pending")
      .select("id")
      .eq("time_off_id", id)
      .maybeSingle();

    if (existing) {
      return { statusCode: 200, body: JSON.stringify({ exists: true, id: existing.id }) };
    }

    let calculatedHours = hours || 8;
    if (!hours && start_date !== end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);
      let count = 0;
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const day = d.getDay();
        if (day !== 0 && day !== 6) count++;
      }
      calculatedHours = count * 8;
    }

    const { error } = await supabase.from("timesheets_pending").insert({
      person,
      start_date,
      end_date,
      hours: calculatedHours,
      status: "pending",
      time_off_id: id,
      notes: note || "",
      created_by: requested_by || "system",
    });

    if (error) throw error;

    console.log(`✓ Pending Timesheets entry for ${person}: ${start_date} to ${end_date}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        created: true,
        person,
        start_date,
        end_date,
        hours: calculatedHours,
      }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
    };
  }
};
