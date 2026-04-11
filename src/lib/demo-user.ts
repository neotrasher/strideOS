import { prisma } from "@/lib/prisma";

export const DEMO_USER_EMAIL = "runner@strideos.local";
const DEMO_USER_NAME = "Runner Demo";

export const ensureDemoUser = async () => {
  return prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: {},
    create: {
      email: DEMO_USER_EMAIL,
      name: DEMO_USER_NAME,
      timezone: "America/Bogota",
    },
  });
};

