package fr.aethoria.menu;

import com.mojang.blaze3d.systems.RenderSystem;
import net.minecraft.ChatFormatting;
import net.minecraft.Util;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.OptionsScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.ServerStatusPinger;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;

/**
 * Menu principal d'Aethoria : diaporama des paysages du serveur, logo, etat du
 * serveur, et trois actions seulement — rejoindre, options, quitter.
 */
public final class AethoriaTitleScreen extends Screen {
    private static final ResourceLocation LOGO = texture("logo");
    private static final int LOGO_WIDTH = 640;
    private static final int LOGO_HEIGHT = 143;

    private static final ResourceLocation[] BACKGROUNDS = {
        texture("backgrounds/1"), texture("backgrounds/2"), texture("backgrounds/3"),
        texture("backgrounds/4"), texture("backgrounds/5"),
    };
    private static final int BACKGROUND_WIDTH = 1280;
    private static final int BACKGROUND_HEIGHT = 720;
    private static final long SLIDE_MS = 9000;
    private static final long FADE_MS = 1800;

    // Adresse officielle, utilisee si le jeu n'a pas ete lance par le launcher.
    private static final String DEFAULT_SERVER = "aethoria.omgcraft.fr:25565";

    // Le diaporama reprend ou il en etait quand le joueur revient au menu.
    private static final long START = Util.getMillis();

    private static final int GOLD = 0xE6B85C;
    private static final int BUTTON_WIDTH = 240;

    private final ServerStatusPinger pinger = new ServerStatusPinger();
    private final ServerData server = new ServerData("Aethoria", serverAddress(), false);
    private long pingStartedAt;
    private String statusText = "Recherche du serveur…";
    private int statusColor = 0xA8A49D;

    public AethoriaTitleScreen() {
        super(Component.literal("Aethoria"));
    }

    private static ResourceLocation texture(String name) {
        return new ResourceLocation(AethoriaMenu.MOD_ID, "textures/gui/" + name + ".png");
    }

    /** Adresse transmise par le launcher (-Daethoria.server), sinon l'adresse officielle. */
    private static String serverAddress() {
        String address = System.getProperty("aethoria.server");
        return address == null || address.isBlank() ? DEFAULT_SERVER : address.trim();
    }

    @Override
    protected void init() {
        // Filtrage lisse : sans lui, les photos redimensionnees crenellent.
        this.minecraft.getTextureManager().getTexture(LOGO).setFilter(true, false);
        for (ResourceLocation background : BACKGROUNDS) {
            this.minecraft.getTextureManager().getTexture(background).setFilter(true, false);
        }

        int x = this.width / 2 - BUTTON_WIDTH / 2;
        int y = this.height / 2 + 10;
        int half = BUTTON_WIDTH / 2 - 3;

        addRenderableWidget(new AethoriaButton(x, y, BUTTON_WIDTH, 28,
            Component.literal("Rejoindre Aethoria").withStyle(ChatFormatting.BOLD), true, this::join));
        addRenderableWidget(new AethoriaButton(x, y + 34, half, 22,
            Component.translatable("menu.options"), false,
            () -> this.minecraft.setScreen(new OptionsScreen(this, this.minecraft.options))));
        addRenderableWidget(new AethoriaButton(x + BUTTON_WIDTH - half, y + 34, half, 22,
            Component.translatable("menu.quit"), false, this.minecraft::stop));

        if (pingStartedAt == 0) pingServer();
    }

    /** Ping hors du fil de rendu : la connexion bloque le temps de joindre le serveur. */
    private void pingServer() {
        pingStartedAt = Util.getMillis();
        Thread thread = new Thread(() -> {
            try {
                pinger.pingServer(server, () -> { });
            } catch (Exception e) {
                statusText = "Serveur injoignable";
                statusColor = 0xFF8A8F;
            }
        }, "Aethoria - etat du serveur");
        thread.setDaemon(true);
        thread.start();
    }

    @Override
    public void tick() {
        pinger.tick();
        if (server.players != null) {
            statusText = "● En ligne · " + server.players.online() + "/" + server.players.max() + " joueurs"
                + (server.ping >= 0 ? " · " + server.ping + " ms" : "");
            statusColor = 0x7CE39A;
        } else if (Util.getMillis() - pingStartedAt > 8000 && statusText.startsWith("Recherche")) {
            statusText = "● Serveur hors ligne";
            statusColor = 0xFF8A8F;
        }
    }

    private void join() {
        String address = serverAddress();
        ConnectScreen.startConnecting(this, this.minecraft, ServerAddress.parseString(address),
            new ServerData("Aethoria", address, false), false);
    }

    @Override
    public void render(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        renderSlideshow(graphics);

        // Voiles : le haut et surtout le bas s'assombrissent pour la lisibilite.
        graphics.fillGradient(0, 0, this.width, this.height / 2, 0x90000000, 0x20000000);
        graphics.fillGradient(0, this.height / 2, this.width, this.height, 0x20000000, 0xE0000000);

        // Le logo se reduit sur les petites fenetres pour ne jamais toucher le haut.
        int logoRoom = Math.max(20, this.height / 2 - 34 - 10);
        int logoWidth = Math.min(Math.min(this.width - 40, 340), logoRoom * LOGO_WIDTH / LOGO_HEIGHT);
        int logoHeight = logoWidth * LOGO_HEIGHT / LOGO_WIDTH;
        int logoY = this.height / 2 - logoHeight - 34;
        RenderSystem.enableBlend();
        graphics.blit(LOGO, this.width / 2 - logoWidth / 2, logoY, 0, 0, logoWidth, logoHeight, logoWidth, logoHeight);
        RenderSystem.disableBlend();
        graphics.drawCenteredString(this.font, "Serveur médiéval · Minecraft 1.20.1",
            this.width / 2, logoY + logoHeight + 6, GOLD);

        int statusY = this.height / 2 + 10 + 34 + 22 + 10;
        graphics.drawCenteredString(this.font, statusText, this.width / 2, statusY, statusColor);
        graphics.drawString(this.font, "Aethoria", 4, this.height - 12, 0x80FFFFFF);
        String address = serverAddress().replace(":25565", "");
        graphics.drawString(this.font, address, this.width - this.font.width(address) - 4, this.height - 12, 0x80FFFFFF);

        super.render(graphics, mouseX, mouseY, partialTick);
    }

    /** Paysages du serveur en fondu, avec un zoom lent. */
    private void renderSlideshow(GuiGraphics graphics) {
        long elapsed = Util.getMillis() - START;
        int index = (int) ((elapsed / SLIDE_MS) % BACKGROUNDS.length);
        long inSlide = elapsed % SLIDE_MS;

        drawCover(graphics, BACKGROUNDS[index], inSlide / (float) SLIDE_MS, 1.0F);
        if (inSlide > SLIDE_MS - FADE_MS) {
            float alpha = (inSlide - (SLIDE_MS - FADE_MS)) / (float) FADE_MS;
            drawCover(graphics, BACKGROUNDS[(index + 1) % BACKGROUNDS.length], 0.0F, alpha);
        }
    }

    /** Dessine une image qui couvre tout l'ecran, centree. */
    private void drawCover(GuiGraphics graphics, ResourceLocation image, float progress, float alpha) {
        float scale = Math.max(this.width / (float) BACKGROUND_WIDTH, this.height / (float) BACKGROUND_HEIGHT)
            * (1.02F + 0.08F * progress);

        graphics.pose().pushPose();
        graphics.pose().translate(this.width / 2.0F, this.height / 2.0F, 0.0F);
        graphics.pose().scale(scale, scale, 1.0F);
        RenderSystem.enableBlend();
        RenderSystem.setShaderColor(1.0F, 1.0F, 1.0F, alpha);
        graphics.blit(image, -BACKGROUND_WIDTH / 2, -BACKGROUND_HEIGHT / 2, 0, 0,
            BACKGROUND_WIDTH, BACKGROUND_HEIGHT, BACKGROUND_WIDTH, BACKGROUND_HEIGHT);
        RenderSystem.setShaderColor(1.0F, 1.0F, 1.0F, 1.0F);
        RenderSystem.disableBlend();
        graphics.pose().popPose();
    }

    @Override
    public void removed() {
        pinger.removeAll();
    }

    // Echap ne doit pas fermer le menu : il n'y a rien derriere.
    @Override
    public boolean shouldCloseOnEsc() {
        return false;
    }
}
