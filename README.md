# PromptCam — Teleprompter PWA

Teleprompter leve, moderno e offline-first em **Português (pt-BR)**, projetado especialmente para rodar no **Google Chrome do Android** posicionado logo acima da lente da câmera.

Construído com HTML5, CSS3 moderno e JavaScript ES Modules puros (zero build, zero frameworks e zero requisições externas), consumindo o mínimo possível de CPU, memória e bateria no celular.

## Recursos

- **Visual Studio OLED (`#000000`)**: fundo preto puro para economizar bateria em telas AMOLED e evitar reflexo de luz no rosto durante a gravação. Inclui também temas **Estúdio Escuro** e **Alto Contraste (Amarelo)**.
- **Ajustes ao vivo (`Aa`)**: altere tamanho da fonte (`20px–96px`), entrelinha (`1.1–2.4`), margem lateral, posição vertical da linha de foco (alinhada à câmera), contagem regressiva (`0s`, `3s`, `5s`) e espelhamento horizontal.
- **Avanço automático suave**: velocidade ajustável de `0.5x` a `10.0x` com curva progressiva para leitura lenta precisa.
- **Avanço automático por voz (SpeechRecognition)**: acompanha sua fala em tempo real via Web Speech API (otimizado para o Chrome no Android), destacando a palavra atual sem poluir o DOM e tolerando pequenas variações ou pausas.
- **Economia máxima de bateria (Zero Idle CPU)**: nenhum loop `requestAnimationFrame` roda quando pausado, quando o app está em segundo plano ou após o texto estabilizar na posição falada.
- **Gerenciador de roteiros offline**: crie múltiplos roteiros salvos automaticamente no `localStorage`, veja estimativa de tempo de fala e importe/exporte arquivos `.txt`.
- **Tela sempre ligada (Wake Lock)** e modo **Tela Cheia** com ocultação automática dos controles durante a gravação.
- **PWA instalável**: adicione à tela inicial do Android para abrir sem barras do navegador e funcionar offline.

## Dicas de Uso no Chrome (Android)

1. **Posição acima da câmera**: abra **Ajustes (`Aa`)** e ajuste **Linha de foco (câmera)** para ~`20%–35%` em retrato ou conforme a altura do furo da câmera no seu aparelho, mantendo seus olhos alinhados à lente.
2. **Reconhecimento de voz offline**: nas configurações do Android (*Sistema → Idiomas → Reconhecimento de voz*), baixe o pacote offline de **Português (Brasil)** para reduzir latência e funcionar sem internet.
3. **Instalação como app**: no Chrome do Android, toque em **Instalar** na barra superior (ou no menu `⋮` → *Adicionar à tela inicial*).

## Atalhos de Teclado / Controle Bluetooth

| Tecla | Ação |
| --- | --- |
| `Espaço` | Iniciar / Pausar (ou cancelar contagem) |
| `Seta ↑` / `Seta →` | Aumentar velocidade |
| `Seta ↓` / `Seta ←` | Diminuir velocidade |
| `R` | Voltar ao início do roteiro |
| `V` | Ativar / Desativar avanço por voz |
| `F` | Alternar tela cheia |
| `M` | Espelhar texto horizontalmente |

> **Dica no toque**: um toque na tela revela os controles ocultos; toque duplo inicia ou pausa a rolagem.

## Como Hospedar no GitHub Pages

O projeto já usa caminhos relativos (`./`) e inclui `.nojekyll`, funcionando tanto no domínio raiz quanto em subpastas (`https://seu-usuario.github.io/seu-repo/`).

1. Envie todos os arquivos deste diretório para um repositório no GitHub.
2. No repositório, acesse **Settings → Pages**.
3. Em **Build and deployment**, escolha **Deploy from a branch**, selecione a branch `main` (pasta `/ (root)`) e clique em **Save**.

Em cerca de 1 minuto o app estará disponível em HTTPS pronto para instalar no Android.
