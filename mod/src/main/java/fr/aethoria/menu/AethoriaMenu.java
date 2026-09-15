package fr.aethoria.menu;

import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.client.event.ScreenEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraftforge.fml.common.Mod;

/**
 * Menu Aethoria : l'ecran titre de Minecraft est remplace par un menu qui ne
 * propose que de rejoindre le serveur, les options et la sortie du jeu. Pas de
 * solo, pas de Realms.
 *
 * Mod purement client : le serveur n'a rien a installer.
 */
@Mod(AethoriaMenu.MOD_ID)
public final class AethoriaMenu {
    public static final String MOD_ID = "aethoriamenu";

    @Mod.EventBusSubscriber(modid = MOD_ID, value = Dist.CLIENT)
    public static final class ClientEvents {
        private ClientEvents() {
        }

        /**
         * Toute ouverture de l'ecran titre passe par ici : au demarrage, apres
         * une deconnexion ou une expulsion. Le joueur retombe donc toujours sur
         * le menu Aethoria.
         */
        @SubscribeEvent
        public static void onScreenOpening(ScreenEvent.Opening event) {
            if (event.getNewScreen() instanceof TitleScreen) {
                event.setNewScreen(new AethoriaTitleScreen());
            }
        }
    }
}
