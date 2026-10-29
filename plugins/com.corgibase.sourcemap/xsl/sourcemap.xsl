<?xml version="1.0" encoding="UTF-8"?>
<!-- Preprocessing stamps every element with @xtrf (source file URI) and @xtrc
     ("name:count;line:col"). Conref'd content keeps the xtrf/xtrc of the element it was
     copied from, so reused text points at its real source. Emit them as data attributes. -->
<xsl:stylesheet version="3.0"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
                xmlns:xs="http://www.w3.org/2001/XMLSchema"
                exclude-result-prefixes="xs">

  <xsl:param name="corgi.sourcemap" as="xs:string" select="'no'"/>

  <xsl:template match="*[@xtrf]" mode="commonattributes" priority="20">
    <xsl:next-match/>
    <xsl:if test="$corgi.sourcemap = 'yes'">
      <xsl:attribute name="data-src-file" select="@xtrf"/>
      <xsl:if test="contains(@xtrc, ';')">
        <xsl:attribute name="data-src-pos" select="substring-after(@xtrc, ';')"/>
      </xsl:if>
    </xsl:if>
  </xsl:template>
</xsl:stylesheet>
