setTimeout(function () {

    console.log("[AOBP] accordion");

    const headers = document.querySelectorAll("#questiontable td.header");

    headers.forEach(header => {

        const headerRow = header.parentElement;
        const contentRow = headerRow.nextElementSibling;

        if (!contentRow) return;

        const label = header.querySelector('[data-mlm-type="header"]');
        if (!label) return;

        // find the inner content div (THIS is what we animate)
        const contentDiv = contentRow.querySelector("td .rich-text-field-label");
        if (!contentDiv) return;

        // create arrow
        const arrow = document.createElement("span");
        arrow.innerText = "\u25B6 ";
        arrow.style.marginRight = "6px";

        label.prepend(arrow);

        // start collapsed (hide content smoothly-ready)
        $(contentDiv).hide();

        header.addEventListener("click", function () {

            const isOpen = header.classList.contains("open");

            // close everything
            headers.forEach(h => {
                const r = h.parentElement;
                const c = r.nextElementSibling;

                const d = c ? c.querySelector("td .rich-text-field-label") : null;

                if (d) $(d).slideUp(200);

                h.classList.remove("open");

                const lbl = h.querySelector('[data-mlm-type="header"]');
                if (lbl && lbl.firstChild) {
                    lbl.firstChild.innerText = "\u25B6 ";
                }
            });

            // open this one
            if (!isOpen) {
                $(contentDiv).slideDown(200);
                header.classList.add("open");
                arrow.innerText = "\u25BC ";
            }

        });

    });

}, 300);