import { Resend } from "resend";

const resendApiKey = process.env.RESEND_API_KEY || "";
const fromEmail = process.env.RESEND_FROM_EMAIL || "OneSpec <noreply@onespec.ai>";
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

const resend = resendApiKey ? new Resend(resendApiKey) : null;

function buildWelcomeEmail(businessName) {
  const subject = `Welcome to OneSpec — your 14-day free trial has started`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 16px;">
      <h1 style="font-size: 24px; color: #0f1f1a; margin-bottom: 16px;">Welcome to OneSpec!</h1>
      <p style="font-size: 15px; color: #0f1f1a; line-height: 1.6;">
        Your AI receptionist for <strong>${businessName}</strong> is ready to take calls. You have <strong>14 days</strong> of full access to try everything out.
      </p>
      <p style="font-size: 15px; color: #0f1f1a; line-height: 1.6;">
        During your trial you can:
      </p>
      <ul style="font-size: 15px; color: #0f1f1a; line-height: 1.8;">
        <li>Receive unlimited inbound calls</li>
        <li>Customize your AI receptionist's voice and instructions</li>
        <li>Book appointments and capture leads automatically</li>
      </ul>
      <p style="margin-top: 24px;">
        <a href="${frontendUrl}/dashboard" style="display: inline-block; background: #f97316; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 999px; font-size: 14px; font-weight: 600;">Go to your dashboard</a>
      </p>
      <p style="font-size: 13px; color: #0f1f1a99; margin-top: 32px;">
        Questions? Just reply to this email.
      </p>
    </div>
  `;
  return { subject, html };
}

function buildTrialReminderEmail(businessName, daysLeft) {
  const subject = daysLeft === 1
    ? `Your OneSpec trial ends tomorrow`
    : `${daysLeft} days left in your OneSpec trial`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 16px;">
      <h1 style="font-size: 24px; color: #0f1f1a; margin-bottom: 16px;">Your trial ${daysLeft === 1 ? 'ends tomorrow' : `has ${daysLeft} days left`}</h1>
      <p style="font-size: 15px; color: #0f1f1a; line-height: 1.6;">
        Your free trial for <strong>${businessName}</strong> ${daysLeft === 1 ? 'expires tomorrow' : `expires in ${daysLeft} days`}. After that, your AI receptionist will stop answering calls.
      </p>
      <p style="font-size: 15px; color: #0f1f1a; line-height: 1.6;">
        Subscribe now to keep your receptionist running without interruption.
      </p>
      <p style="margin-top: 24px;">
        <a href="${frontendUrl}/dashboard/settings" style="display: inline-block; background: #f97316; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 999px; font-size: 14px; font-weight: 600;">Choose a plan</a>
      </p>
      <p style="font-size: 13px; color: #0f1f1a99; margin-top: 32px;">
        Questions? Just reply to this email.
      </p>
    </div>
  `;
  return { subject, html };
}

function buildTrialExpiredEmail(businessName) {
  const subject = `Your OneSpec free trial has ended`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 16px;">
      <h1 style="font-size: 24px; color: #991b1b; margin-bottom: 16px;">Your free trial has ended</h1>
      <p style="font-size: 15px; color: #0f1f1a; line-height: 1.6;">
        The 14-day free trial for <strong>${businessName}</strong> has expired. Your AI receptionist is no longer answering calls.
      </p>
      <p style="font-size: 15px; color: #0f1f1a; line-height: 1.6;">
        Subscribe to reactivate your receptionist and keep capturing leads.
      </p>
      <p style="margin-top: 24px;">
        <a href="${frontendUrl}/dashboard/settings" style="display: inline-block; background: #ef4444; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 999px; font-size: 14px; font-weight: 600;">Reactivate now</a>
      </p>
      <p style="font-size: 13px; color: #0f1f1a99; margin-top: 32px;">
        Questions? Just reply to this email.
      </p>
    </div>
  `;
  return { subject, html };
}

async function sendTrialEmail(toEmail, emailContent, log) {
  if (!resend) {
    log("trial_email_skipped", { reason: "resend_not_configured", to: toEmail });
    return false;
  }

  try {
    await resend.emails.send({
      from: fromEmail,
      to: [toEmail],
      subject: emailContent.subject,
      html: emailContent.html,
    });
    return true;
  } catch (error) {
    log("trial_email_send_failed", { to: toEmail, message: error?.message || String(error) });
    return false;
  }
}

export async function checkAndSendTrialEmails(admin, log) {
  if (!resend) {
    log("trial_email_check_skipped", { reason: "resend_not_configured" });
    return;
  }

  try {
    const { data: businesses, error } = await admin
      .from("b2b_businesses")
      .select("id, name, email, trial_ends_at, last_trial_email_sent")
      .eq("subscription_status", "TRIALING")
      .not("email", "is", null);

    if (error) {
      log("trial_email_query_failed", { message: error.message });
      return;
    }

    if (!businesses || businesses.length === 0) return;

    for (const biz of businesses) {
      if (!biz.email || !biz.trial_ends_at) continue;

      const msLeft = new Date(biz.trial_ends_at).getTime() - Date.now();
      const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
      const lastSent = biz.last_trial_email_sent;

      let emailToSend = null;
      let emailTag = null;

      if (!lastSent) {
        // Welcome email
        emailToSend = buildWelcomeEmail(biz.name);
        emailTag = "welcome";
      } else if (daysLeft <= 0 && lastSent !== "expired") {
        emailToSend = buildTrialExpiredEmail(biz.name);
        emailTag = "expired";
      } else if (daysLeft <= 1 && daysLeft > 0 && lastSent !== "1_day" && lastSent !== "expired") {
        emailToSend = buildTrialReminderEmail(biz.name, 1);
        emailTag = "1_day";
      } else if (daysLeft <= 3 && daysLeft > 1 && lastSent !== "3_day" && lastSent !== "1_day" && lastSent !== "expired") {
        emailToSend = buildTrialReminderEmail(biz.name, daysLeft);
        emailTag = "3_day";
      }

      if (!emailToSend || !emailTag) continue;

      const sent = await sendTrialEmail(biz.email, emailToSend, log);
      if (sent) {
        await admin
          .from("b2b_businesses")
          .update({ last_trial_email_sent: emailTag })
          .eq("id", biz.id);

        log("trial_email_sent", { businessId: biz.id, email: biz.email, tag: emailTag, daysLeft });
      }
    }
  } catch (error) {
    log("trial_email_check_error", { message: error?.message || String(error) });
  }
}
