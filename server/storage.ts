// server/storage.ts
import { db } from "./db";
import {
  users, availabilitySlots, availabilityMatches,
  notifications, hosts, hostApplications,
} from "@shared/schema";
import type {
  User, AvailabilitySlot, Notification, Host, HostApplication,
} from "@shared/schema";
import { eq, and, desc, isNotNull, sql } from "drizzle-orm";

export const storage = {

  // ── Users ───────────────────────────────────────────────────────────────
  async getUser(id: number) {
    const [u] = await db.select().from(users).where(eq(users.id, id));
    return u as User | undefined;
  },
  async getUserByUsername(username: string) {
    const [u] = await db.select().from(users).where(eq(users.username, username));
    return u as User | undefined;
  },
  async getUserByEmail(email: string) {
    const [u] = await db.select().from(users).where(eq(users.email, email));
    return u as User | undefined;
  },
  async getUserByGoogleId(googleId: string) {
    const [u] = await db.select().from(users).where(eq(users.googleId, googleId));
    return u as User | undefined;
  },
  async getUserByYandexId(yandexId: string) {
    const [u] = await db.select().from(users).where(eq(users.yandexId, yandexId));
    return u as User | undefined;
  },
  async getUserByTelegramId(telegramId: string) {
    const [u] = await db.select().from(users).where(eq(users.telegramId, telegramId));
    return u as User | undefined;
  },
  async createUser(data: typeof users.$inferInsert) {
    const [u] = await db.insert(users).values(data).returning();
    return u as User;
  },
  async updateUser(id: number, data: Partial<typeof users.$inferInsert>) {
    const [u] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return u as User | undefined;
  },
  async getUsersWithTelegramId() {
    return db.select().from(users).where(isNotNull(users.telegramId));
  },

  // ── Availability ─────────────────────────────────────────────────────────
  async getUserSlots(userId: number) {
    return db.select().from(availabilitySlots).where(eq(availabilitySlots.userId, userId));
  },
  async setUserSlots(userId: number, slots: Array<{ day: number; hour: number; appScope?: string }>) {
    await db.delete(availabilitySlots).where(eq(availabilitySlots.userId, userId));
    if (slots.length > 0) {
      await db.insert(availabilitySlots).values(
        slots.map(s => ({ userId, day: s.day, hour: s.hour, appScope: s.appScope ?? "both" }))
      );
    }
  },
  async getUserMatches(userId: number) {
    const all = await db.select().from(availabilityMatches);
    return all.filter(m => m.userIds.includes(userId));
  },
  async createMatch(data: typeof availabilityMatches.$inferInsert) {
    const [m] = await db.insert(availabilityMatches).values(data).returning();
    return m;
  },
  async getPendingMatches(appScope?: string) {
    const all = await db.select().from(availabilityMatches)
      .where(eq(availabilityMatches.notified, false));
    return appScope ? all.filter(m => m.appScope === appScope) : all;
  },
  async markMatchNotified(id: number) {
    await db.update(availabilityMatches).set({ notified: true })
      .where(eq(availabilityMatches.id, id));
  },
  async clearMatches(appScope?: string) {
    if (appScope) {
      await db.delete(availabilityMatches).where(eq(availabilityMatches.appScope, appScope));
    } else {
      await db.delete(availabilityMatches);
    }
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  async createNotification(data: typeof notifications.$inferInsert) {
    await db.insert(notifications).values(data);
  },
  async getUserNotifications(userId: number, appScope?: string) {
    const all = await db.select().from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    return appScope ? all.filter(n => n.appScope === appScope) : all;
  },
  async markNotificationsRead(userId: number) {
    await db.update(notifications).set({ read: true })
      .where(eq(notifications.userId, userId));
  },
  async getUnreadCount(userId: number, appScope?: string) {
    const all = await db.select().from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
    const filtered = appScope ? all.filter(n => n.appScope === appScope) : all;
    return filtered.length;
  },

  // ── Host registry ─────────────────────────────────────────────────────────
  async getHost(id: number) {
    const [h] = await db.select().from(hosts).where(eq(hosts.id, id));
    return h as Host | undefined;
  },
  async getHostBySlug(slug: string) {
    const [h] = await db.select().from(hosts).where(eq(hosts.slug, slug));
    return h as Host | undefined;
  },
  async getApprovedHosts() {
    return db.select().from(hosts).where(eq(hosts.status, "approved"));
  },
  async createHost(data: typeof hosts.$inferInsert) {
    const [h] = await db.insert(hosts).values(data).returning();
    return h as Host;
  },
  async updateHost(id: number, data: Partial<typeof hosts.$inferInsert>) {
    const [h] = await db.update(hosts).set(data).where(eq(hosts.id, id)).returning();
    return h as Host | undefined;
  },

  // ── Host applications ──────────────────────────────────────────────────────
  async createApplication(data: typeof hostApplications.$inferInsert) {
    const [a] = await db.insert(hostApplications).values(data).returning();
    return a as HostApplication;
  },
  async getPendingApplications() {
    return db.select().from(hostApplications)
      .where(eq(hostApplications.status, "pending"))
      .orderBy(desc(hostApplications.createdAt));
  },
  async getApplication(id: number) {
    const [a] = await db.select().from(hostApplications).where(eq(hostApplications.id, id));
    return a as HostApplication | undefined;
  },
  async approveApplication(id: number, adminId: number) {
    // Mark application approved
    const [app] = await db.update(hostApplications)
      .set({ status: "approved" })
      .where(eq(hostApplications.id, id))
      .returning();

    if (!app) throw new Error("Application not found");

    // Create the host record
    const host = await this.createHost({
      slug:           app.slug,
      name:           app.name,
      description:    app.description,
      category:       app.category,
      ownerUserId:    app.applicantId ?? undefined,
      paymentUrl:     app.paymentUrl ?? undefined,
      websiteUrl:     app.websiteUrl ?? undefined,
      telegramHandle: app.telegramHandle ?? undefined,
      status:         "approved",
      approvedAt:     new Date(),
      approvedBy:     adminId,
    });

    return host;
  },
  async rejectApplication(id: number, notes?: string) {
    await db.update(hostApplications)
      .set({ status: "rejected", notes: notes ?? null })
      .where(eq(hostApplications.id, id));
  },
};
