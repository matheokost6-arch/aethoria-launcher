package fr.aethoria.menu;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.AbstractButton;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.network.chat.Component;

/** Bouton aux couleurs du launcher : rouge pour l'action principale, sombre pour les autres. */
final class AethoriaButton extends AbstractButton {
    private final boolean primary;
    private final Runnable action;

    AethoriaButton(int x, int y, int width, int height, Component label, boolean primary, Runnable action) {
        super(x, y, width, height, label);
        this.primary = primary;
        this.action = action;
    }

    @Override
    public void onPress() {
        action.run();
    }

    @Override
    protected void renderWidget(GuiGraphics graphics, int mouseX, int mouseY, float partialTick) {
        boolean hot = isHoveredOrFocused();
        int background = primary ? (hot ? 0xF2E8434A : 0xE6C8252C) : (hot ? 0xD02A2B31 : 0xB0121317);
        int border = primary ? (hot ? 0xFFFF9A9E : 0xFF7E1217) : (hot ? 0xFFBDBDBD : 0x50FFFFFF);

        int x = getX();
        int y = getY();
        graphics.fill(x, y, x + width, y + height, background);
        graphics.fill(x, y, x + width, y + 1, border);
        graphics.fill(x, y + height - 1, x + width, y + height, border);
        graphics.fill(x, y, x + 1, y + height, border);
        graphics.fill(x + width - 1, y, x + width, y + height, border);

        graphics.drawCenteredString(Minecraft.getInstance().font, getMessage(),
            x + width / 2, y + (height - 8) / 2, active ? 0xFFFFFF : 0xA0A0A0);
    }

    @Override
    protected void updateWidgetNarration(NarrationElementOutput output) {
        defaultButtonNarrationText(output);
    }
}
