/**
 * Focus-State Spatial D-Pad Manager - Modern webOS 22+ Hardened Specification
 */
const SpatialNavigationEngine = {
    activeFocusElement: null,

    init() {
        window.addEventListener("keydown", (event) => this.interceptHardwareKeys(event));
        this.rescanActiveContext();
    },

    rescanActiveContext() {
        const exitModal = document.getElementById('exit-modal');
        if (exitModal && exitModal.style.display === 'flex') {
            const firstModalTarget = exitModal.querySelector(".focusable");
            if (firstModalTarget) {
                this.assignFocus(firstModalTarget);
                return;
            }
        }

        const currentVisibleScreen = document.querySelector(".screen.active, #sidebar");
        if (!currentVisibleScreen) return;

        const firstTarget = currentVisibleScreen.querySelector(".focusable, .nav-item");
        if (firstTarget) this.assignFocus(firstTarget);
    },

    assignFocus(element) {
        if (!element) return;
        if (this.activeFocusElement) this.activeFocusElement.blur();
        
        this.activeFocusElement = element;
        element.focus();

        if (typeof element.scrollIntoView === "function") {
            element.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
    },

    interceptHardwareKeys(event) {
        const activeElement = document.activeElement;
        
        if (
          activeElement &&
          (activeElement.tagName === "INPUT" ||
            activeElement.tagName === "TEXTAREA" ||
            activeElement.tagName === "SELECT" ||
            activeElement.isContentEditable)
        ) {
          return;
        }

        if (event.key === "BrowserBack" || event.key === "GoBack" || event.keyCode === 461 || event.key === "Backspace") {
            event.preventDefault();
            if (typeof ApplicationOrchestrator !== "undefined") {
                ApplicationOrchestrator.navigateBackStack();
            }
            return;
        }

        let destinationNode = null;

        switch (event.key) {
            case "ArrowLeft":
            case "Left": 
                destinationNode = this.computeVectorMap("left");
                break;
            case "ArrowUp":
            case "Up":
                destinationNode = this.computeVectorMap("up");
                break;
            case "ArrowRight":
            case "Right":
                destinationNode = this.computeVectorMap("right");
                break;
            case "ArrowDown":
            case "Down":
                destinationNode = this.computeVectorMap("down");
                break; // FIXED: Core statement restored to stop click fall-through anomalies
            case "Enter":
                if (this.activeFocusElement) this.activeFocusElement.click();
                break;
        }

        if (destinationNode) {
            this.assignFocus(destinationNode);
            event.preventDefault();
        }
    },

    computeVectorMap(direction) {
        if (!this.activeFocusElement) return null;

        const exitModal = document.getElementById('exit-modal');
        const isModalOpen = exitModal && exitModal.style.display === 'flex';
        const targetSearchScopeNode = isModalOpen ? exitModal : document;

        const potentialNodes = Array.from(targetSearchScopeNode.querySelectorAll(".focusable, .nav-item")).filter(node => {
            const rect = node.getBoundingClientRect();
            const hasDimensions = rect.width > 0 && rect.height > 0 && node.offsetWidth > 0 && node.offsetHeight > 0;
            const isVisible = typeof node.checkVisibility === "function" ? node.checkVisibility() : true;
            return hasDimensions && isVisible && node !== this.activeFocusElement;
        });

        const anchorRect = this.activeFocusElement.getBoundingClientRect();
        const anchorX = anchorRect.left + anchorRect.width / 2;
        const anchorY = anchorRect.top + anchorRect.height / 2;

        let closestNode = null;
        let shortestDistance = Infinity;

        potentialNodes.forEach(candidate => {
            const candidateRect = candidate.getBoundingClientRect();
            const candidateX = candidateRect.left + candidateRect.width / 2;
            const candidateY = candidateRect.top + candidateRect.height / 2;

            const dx = candidateX - anchorX;
            const dy = candidateY - anchorY;

            let strictBoundMatch = false;

            switch (direction) {
                case "left": strictBoundMatch = dx < 0 && Math.abs(dy) < Math.abs(dx) * 1.2; break;
                case "right": strictBoundMatch = dx > 0 && Math.abs(dy) < Math.abs(dx) * 1.2; break;
                case "up": strictBoundMatch = dy < 0 && Math.abs(dx) < Math.abs(dy) * 1.2; break;
                case "down": strictBoundMatch = dy > 0 && Math.abs(dx) < Math.abs(dy) * 1.2; break;
            }

            if (!strictBoundMatch) return;

            const vectorDistance = (dx * dx) + (dy * dy);
            if (vectorDistance < shortestDistance) {
                shortestDistance = vectorDistance;
                closestNode = candidate;
            }
        });

        return closestNode;
    }
};

window.addEventListener("DOMContentLoaded", () => SpatialNavigationEngine.init());